/**
 * alert-store.ts — persistence and lifecycle for infra alert rules and the
 * alerts they fire (decision INFRA-ALERT).
 *
 * Three modules split the alerting problem along one seam: `alert-evaluator.ts`
 * is pure and IO-free and answers "what state does this range of datapoints
 * put this rule in"; this module owns every row and every state transition; the
 * collector tick (its own ticket) is the only thing that holds both a clock and
 * a CloudWatch client. Keeping the evaluator ignorant of storage is what lets
 * the CloudWatch-parity semantics be unit-tested exhaustively without a
 * database, and keeping the transitions here is what lets them be tested
 * without a metric.
 *
 * The lifecycle is `log-issues-store.ts`'s, deliberately: decision INFRA-ALERT
 * says an alert "should look the same to the user as a log issue does", so
 * recurrence reopens a resolved alert, `ignored` stays muted through
 * recurrence, and out-of-order observations keep the true min/max window.
 *
 * The one thing this module adds over that precedent is a staleness guard.
 * A log record's arrival order is arbitrary but its content is fixed; an alarm
 * *state* is a claim about a moment in time, so a late-arriving evaluation of
 * an older window must not overwrite the state a newer window already decided.
 * See {@link recordInfraAlertEvaluation}.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { getInfraDb } from './infra-db.js';
import {
  INFRA_ALERT_SEVERITIES,
  DEFAULT_INFRA_ALERT_SEVERITY,
  INFRA_ALERT_STATUSES,
  INFRA_ALERT_TRANSITION_HISTORY_LIMIT,
  INFRA_ALERT_RECURRENCE_ACTOR,
  INFRA_ALERT_RECOVERY_ACTOR,
  INFRA_ALERT_EVALUATOR_ACTOR,
  MAX_INFRA_ALERT_LIST_LIMIT,
  DEFAULT_INFRA_ALERT_LIST_LIMIT,
  type InfraAlertSeverity,
  type InfraAlertStatus,
} from './infra-schema.js';
import {
  DEFAULT_INFRA_TREAT_MISSING_DATA,
  type InfraAlarmState,
  type InfraAlarmReason,
  type InfraAlarmEvaluation,
  type InfraComparisonOperator,
  type InfraTreatMissingData,
  type InfraAlertRule as InfraThresholdRule,
} from './alert-evaluator.js';

// ── Row shapes ─────────────────────────────────────────────────────────────

/** `infra_alert_rules` as stored. */
export interface InfraAlertRuleRow {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  service: string;
  account_id: string | null;
  region: string | null;
  resource_key: string | null;
  tag_filter_json: string | null;
  namespace: string;
  metric_name: string;
  stat: string;
  period_s: number;
  threshold: number;
  comparison_operator: InfraComparisonOperator;
  evaluation_periods: number;
  datapoints_to_alarm: number | null;
  treat_missing_data: InfraTreatMissingData;
  severity: InfraAlertSeverity;
  enabled: number;
  created_at: number;
  updated_at: number;
}

/** `infra_alerts` as stored. */
export interface InfraAlertRow {
  id: string;
  project_id: string;
  rule_id: string;
  resource_key: string;
  state: InfraAlarmState;
  reason: InfraAlarmReason | null;
  state_updated_at: number;
  status: InfraAlertStatus;
  status_updated_at: number | null;
  status_updated_by: string | null;
  first_seen: number;
  last_seen: number;
  occurrence_count: number;
  last_value: number | null;
  breaching_datapoints: number | null;
  created_at: number;
  updated_at: number;
}

/** `infra_alert_transitions` as stored. */
export interface InfraAlertTransitionRow {
  id: number;
  alert_id: string;
  project_id: string;
  from_state: InfraAlarmState;
  to_state: InfraAlarmState;
  from_status: InfraAlertStatus;
  to_status: InfraAlertStatus;
  reason: InfraAlarmReason | null;
  actor: string;
  at_ms: number;
  notification_delivered_at_ms: number | null;
}

// ── Rule validation ────────────────────────────────────────────────────────

/**
 * A rule the store refuses to persist.
 *
 * A distinct class rather than a plain `Error` so the route layer can map it to
 * a 400 without string-matching a message, the same way
 * `ProjectAwsProfileValidationError` is mapped in `routes/infra.ts`.
 */
export class InfraAlertRuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InfraAlertRuleValidationError';
  }
}

/**
 * An observation whose `(projectId, ruleId)` pair does not agree with the
 * stored alert.
 *
 * `infra_alerts` is UNIQUE on `(rule_id, resource_key)` with no project column
 * in the key, which is correct — `rule_id` is a foreign key into a
 * project-scoped rule, so the rule already determines the project. That makes a
 * mismatch impossible to reach with consistent inputs, and a caller bug when it
 * happens: a collector tick that paired a rule id with the wrong project.
 *
 * Raised rather than silently updating the row, because the row belongs to
 * another tenant. Raised rather than falling through to an insert, because the
 * insert would then fail on the UNIQUE constraint and surface as an opaque
 * SQLITE_CONSTRAINT the caller cannot act on. The collector skips the offending
 * rule and keeps the tick alive.
 */
export class InfraAlertProjectMismatchError extends Error {
  constructor(
    readonly expectedProjectId: string,
    /** The project that actually owns the rule, or null when no such rule exists. */
    readonly actualProjectId: string | null,
    readonly ruleId: string,
  ) {
    super(
      actualProjectId === null
        ? `alert rule ${ruleId} does not exist in project ${expectedProjectId}`
        : `alert rule ${ruleId} belongs to project ${actualProjectId}, not ${expectedProjectId}`,
    );
    this.name = 'InfraAlertProjectMismatchError';
  }
}

/**
 * A store write that owns its transaction boundary was called on a connection
 * already inside a transaction.
 *
 * These writes' atomicity guarantee rests on taking the write lock up front
 * (BEGIN IMMEDIATE). better-sqlite3 implements a nested transaction as a
 * SAVEPOINT and ignores the immediate/exclusive qualifier, so inside someone
 * else's transaction we silently inherit *their* locking mode — and there is no
 * API to ask whether theirs was immediate. A caller who began deferred and read
 * first would hand us a snapshot that cannot upgrade, which surfaces as
 * `SQLITE_BUSY_SNAPSHOT` under concurrency and is not retried by `busy_timeout`.
 *
 * Rather than document a guarantee that quietly evaporates one stack frame up,
 * these functions own their transaction boundary and refuse to run inside one.
 */
export class InfraAlertNestedTransactionError extends Error {
  constructor(readonly fnName: string) {
    super(
      `${fnName}() owns its own IMMEDIATE transaction and cannot be called inside an open ` +
        `transaction; call it per alert rather than batching`,
    );
    this.name = 'InfraAlertNestedTransactionError';
  }
}

/** Fields accepted when creating a rule. */
export interface InfraAlertRuleInput {
  name: string;
  description?: string | null;
  service: string;
  accountId?: string | null;
  region?: string | null;
  resourceKey?: string | null;
  tagFilter?: Record<string, string[]> | null;
  namespace: string;
  metricName: string;
  stat: string;
  periodS: number;
  threshold: number;
  comparisonOperator: InfraComparisonOperator;
  evaluationPeriods: number;
  datapointsToAlarm?: number | null;
  treatMissingData?: InfraTreatMissingData | null;
  severity?: InfraAlertSeverity | null;
  enabled?: boolean;
}

/**
 * Reject a rule the evaluator could never act on.
 *
 * The two shape checks (`datapointsToAlarm <= evaluationPeriods`, the operator
 * and treatment enums) duplicate `normalizeRule()` in the evaluator on purpose.
 * The evaluator throws at tick time, where the only visible consequence is a
 * skipped rule in a log line nobody reads; catching it at write time turns the
 * same mistake into a 400 on the form the operator is looking at. Duplication
 * of a four-line invariant is a smaller cost than an alarm that looks armed and
 * is not.
 */
function assertValidRuleShape(rule: {
  evaluationPeriods: number;
  datapointsToAlarm?: number | null;
  periodS: number;
}): void {
  const { evaluationPeriods, datapointsToAlarm, periodS } = rule;
  if (!Number.isInteger(evaluationPeriods) || evaluationPeriods < 1) {
    throw new InfraAlertRuleValidationError(
      `evaluationPeriods must be an integer >= 1, got ${String(evaluationPeriods)}`,
    );
  }
  if (datapointsToAlarm != null) {
    if (!Number.isInteger(datapointsToAlarm) || datapointsToAlarm < 1) {
      throw new InfraAlertRuleValidationError(
        `datapointsToAlarm must be an integer >= 1, got ${String(datapointsToAlarm)}`,
      );
    }
    if (datapointsToAlarm > evaluationPeriods) {
      throw new InfraAlertRuleValidationError(
        `datapointsToAlarm (${datapointsToAlarm}) exceeds evaluationPeriods (${evaluationPeriods}); ` +
          `such a rule can never reach ALARM`,
      );
    }
  }
  if (!Number.isInteger(periodS) || periodS < 1) {
    throw new InfraAlertRuleValidationError(
      `periodS must be an integer >= 1, got ${String(periodS)}`,
    );
  }
}

/**
 * Serialize a tag predicate for storage.
 *
 * `null` and `{}` both store as NULL: an empty predicate matches everything,
 * which is what "no filter" means, and keeping one representation stops the
 * evaluator needing a special case for a filter that filters nothing.
 */
function serializeTagFilter(filter: Record<string, string[]> | null | undefined): string | null {
  if (!filter || Object.keys(filter).length === 0) return null;
  return JSON.stringify(filter);
}

// ── Rule CRUD ──────────────────────────────────────────────────────────────

/** Insert a rule. Throws {@link InfraAlertRuleValidationError} on a rule that cannot fire. */
export function createInfraAlertRule(
  projectId: string,
  input: InfraAlertRuleInput,
  nowMs: number,
): InfraAlertRuleRow {
  assertValidRuleShape(input);
  const id = uuidv4();
  getInfraDb()
    .prepare(
      `INSERT INTO infra_alert_rules
         (id, project_id, name, description, service, account_id, region, resource_key,
          tag_filter_json, namespace, metric_name, stat, period_s, threshold,
          comparison_operator, evaluation_periods, datapoints_to_alarm,
          treat_missing_data, severity, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      input.name,
      input.description ?? null,
      input.service,
      input.accountId ?? null,
      input.region ?? null,
      input.resourceKey ?? null,
      serializeTagFilter(input.tagFilter),
      input.namespace,
      input.metricName,
      input.stat,
      input.periodS,
      input.threshold,
      input.comparisonOperator,
      input.evaluationPeriods,
      input.datapointsToAlarm ?? null,
      input.treatMissingData ?? DEFAULT_INFRA_TREAT_MISSING_DATA,
      input.severity ?? DEFAULT_INFRA_ALERT_SEVERITY,
      input.enabled === false ? 0 : 1,
      nowMs,
      nowMs,
    );
  return getInfraAlertRule(projectId, id) as InfraAlertRuleRow;
}

/** One rule, or null when it does not exist or belongs to another project. */
export function getInfraAlertRule(projectId: string, ruleId: string): InfraAlertRuleRow | null {
  const row = getInfraDb()
    .prepare('SELECT * FROM infra_alert_rules WHERE project_id = ? AND id = ?')
    .get(projectId, ruleId) as InfraAlertRuleRow | undefined;
  return row ?? null;
}

export interface InfraAlertRuleListQuery {
  projectId: string;
  service?: string;
  enabled?: boolean;
}

/**
 * A project's rules, newest first.
 *
 * Unpaginated on purpose. Rules are hand-authored plus a per-service default
 * pack, so the population is tens per project, not thousands — a cursor here
 * would be machinery for a page that never has a second one. The alert list,
 * whose size is (rules x resources), does paginate.
 */
export function listInfraAlertRules(query: InfraAlertRuleListQuery): InfraAlertRuleRow[] {
  const clauses = ['project_id = ?'];
  const params: unknown[] = [query.projectId];
  if (query.service) {
    clauses.push('service = ?');
    params.push(query.service);
  }
  if (query.enabled !== undefined) {
    clauses.push('enabled = ?');
    params.push(query.enabled ? 1 : 0);
  }
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_rules
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC`,
    )
    .all(...params) as InfraAlertRuleRow[];
}

/** Patch accepted by {@link updateInfraAlertRule}. Absent keys are left alone. */
export type InfraAlertRulePatch = Partial<InfraAlertRuleInput>;

/** Column each patch key writes to, in the order they are applied. */
const RULE_PATCH_COLUMNS: ReadonlyArray<[keyof InfraAlertRuleInput, string]> = [
  ['name', 'name'],
  ['description', 'description'],
  ['service', 'service'],
  ['accountId', 'account_id'],
  ['region', 'region'],
  ['resourceKey', 'resource_key'],
  ['namespace', 'namespace'],
  ['metricName', 'metric_name'],
  ['stat', 'stat'],
  ['periodS', 'period_s'],
  ['threshold', 'threshold'],
  ['comparisonOperator', 'comparison_operator'],
  ['evaluationPeriods', 'evaluation_periods'],
  ['datapointsToAlarm', 'datapoints_to_alarm'],
  ['treatMissingData', 'treat_missing_data'],
  ['severity', 'severity'],
];

/**
 * Patch a rule. Returns null when it does not exist in this project.
 *
 * The shape invariant is re-checked against the *merged* rule, not the patch:
 * lowering `evaluationPeriods` alone can invalidate a `datapointsToAlarm` that
 * was set in an earlier request and is not present in this one.
 */
export function updateInfraAlertRule(
  projectId: string,
  ruleId: string,
  patch: InfraAlertRulePatch,
  nowMs: number,
): InfraAlertRuleRow | null {
  const existing = getInfraAlertRule(projectId, ruleId);
  if (!existing) return null;

  assertValidRuleShape({
    evaluationPeriods: patch.evaluationPeriods ?? existing.evaluation_periods,
    datapointsToAlarm:
      patch.datapointsToAlarm !== undefined
        ? patch.datapointsToAlarm
        : existing.datapoints_to_alarm,
    periodS: patch.periodS ?? existing.period_s,
  });

  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, column] of RULE_PATCH_COLUMNS) {
    if (patch[key] === undefined) continue;
    sets.push(`${column} = ?`);
    params.push(patch[key] ?? null);
  }
  if (patch.tagFilter !== undefined) {
    sets.push('tag_filter_json = ?');
    params.push(serializeTagFilter(patch.tagFilter));
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    params.push(patch.enabled ? 1 : 0);
  }
  if (sets.length === 0) return existing;

  sets.push('updated_at = ?');
  params.push(nowMs, projectId, ruleId);
  getInfraDb()
    .prepare(`UPDATE infra_alert_rules SET ${sets.join(', ')} WHERE project_id = ? AND id = ?`)
    .run(...params);
  return getInfraAlertRule(projectId, ruleId);
}

/**
 * Delete a rule and, by cascade, every alert it fired and their history.
 *
 * The cascade is why the UI offers `enabled: false` as the prominent action: an
 * operator who only wants the paging to stop should not lose the incident
 * record. That choice belongs to them, so this does not silently soft-delete.
 */
export function deleteInfraAlertRule(projectId: string, ruleId: string): boolean {
  const info = getInfraDb()
    .prepare('DELETE FROM infra_alert_rules WHERE project_id = ? AND id = ?')
    .run(projectId, ruleId);
  return info.changes > 0;
}

/** Project the stored rule down to the threshold subset `evaluateInfraAlarm()` takes. */
export function toThresholdRule(row: InfraAlertRuleRow): InfraThresholdRule {
  return {
    comparisonOperator: row.comparison_operator,
    threshold: row.threshold,
    evaluationPeriods: row.evaluation_periods,
    datapointsToAlarm: row.datapoints_to_alarm,
    treatMissingData: row.treat_missing_data,
  };
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

/** What one recorded evaluation did to the stored alert. */
export interface InfraAlertRecordResult {
  /** Null when a non-ALARM evaluation found no existing alert to update. */
  alert: InfraAlertRow | null;
  /** True when this evaluation created the alert row. */
  created: boolean;
  /** True when recurrence moved a `resolved` alert back to `open`. */
  reopened: boolean;
  /** True when recovery moved an `open` alert to `resolved`. */
  autoResolved: boolean;
  /** True when the alarm state changed. Callers fire notifications on this. */
  stateChanged: boolean;
  /** Transition row id when this evaluation recorded a state/status change. */
  transitionId: number | null;
  /**
   * True when the evaluation was older than the state currently stored, so only
   * the aggregates were folded in and no transition was recorded.
   */
  stale: boolean;
}

/** Inputs to {@link recordInfraAlertEvaluation} beyond the evaluation itself. */
export interface InfraAlertObservation {
  projectId: string;
  ruleId: string;
  resourceKey: string;
  evaluation: InfraAlarmEvaluation;
  /**
   * Timestamp of the newest datapoint the evaluation covered — the *data's*
   * clock, not the tick's. Two ticks racing on the same series must order by
   * the window they read, or the loser's stale verdict wins by arriving second.
   */
  observedAtMs: number;
  /** Metric value behind the verdict, for rendering without re-querying. */
  value?: number | null;
  /** Wall clock, for `updated_at` / `status_updated_at`. */
  nowMs: number;
}

/**
 * Fold one evaluation into the (rule, resource) alert row.
 *
 * The state machine, in the order the branches are taken:
 *
 *  1. **No row, not ALARM** — nothing to record. A healthy resource does not
 *     get a row, or the alerts table would be (rules x resources) rows of
 *     "fine" that the operator has to filter past to find the one that is not.
 *     This covers INSUFFICIENT_DATA too: an unobservable resource that never
 *     breached does not open an incident. An operator who wants missing data
 *     to page says so on the rule, via `treatMissingData: 'breaching'`, and the
 *     evaluator then hands us ALARM rather than INSUFFICIENT_DATA.
 *  2. **No row, ALARM** — insert `state: ALARM`, `status: open`, both seen
 *     timestamps at the observation, and an `OK -> ALARM` transition.
 *  3. **Stale** (`observedAtMs < state_updated_at`) — fold the aggregates
 *     (min/max window, occurrence count) and stop. No state move, no status
 *     move, no transition row. A late evaluation is evidence about a window
 *     that already passed, not a claim about now.
 *  4. **ALARM** — recurrence. `resolved` reopens (actor
 *     `system:recurrence`); `ignored` stays muted; `open` stays open. True
 *     min/max via `Math.min`/`Math.max`, exactly as `recordIssueOccurrence`.
 *  5. **OK** — recovery. An `open` alert auto-resolves (actor
 *     `system:recovery`); an `ignored` one stays ignored; an already-`resolved`
 *     one is untouched.
 *  6. **INSUFFICIENT_DATA** — the state moves and is recorded, but the status
 *     does not. Not being able to see a metric is not evidence that it
 *     recovered, so an open incident stays open while the series is dark.
 *
 * Steps 4 and 5 are the halves of the reopen/mute contract, and the reason
 * `ignored` is checked in both: muting has to survive the *round trip*. An
 * implementation that only skipped the reopen would un-mute an alert the first
 * time it recovered, and the operator would be paged by the next breach.
 *
 * **Atomicity.** The whole read-decide-write sequence runs in one IMMEDIATE
 * transaction. Both halves of that matter:
 *
 *   - *One transaction*, because the lookup and the insert are a
 *     check-then-act on a UNIQUE key. Two collector ticks evaluating the same
 *     (rule, resource) could otherwise both read no row, and the loser's insert
 *     would fail the constraint and take its whole tick down. The same window
 *     applies to the update path, where two racing evaluations could each
 *     decide a status transition from the same stale `existing` snapshot and
 *     append two contradictory history rows.
 *   - *IMMEDIATE*, because a deferred transaction takes its write lock lazily:
 *     in WAL mode a reader that upgrades to a writer after another connection
 *     has committed fails with `SQLITE_BUSY_SNAPSHOT`, and `busy_timeout` does
 *     not retry that one — it is not a lock wait, it is a stale snapshot.
 *     Taking the write lock up front converts the race into an ordinary,
 *     timeout-backed lock wait.
 *
 * **This function owns that transaction boundary** and throws
 * {@link InfraAlertNestedTransactionError} if handed a connection already
 * inside one — see that class for why a nested SAVEPOINT cannot carry the
 * guarantee. An earlier revision advertised "safe to call inside an outer
 * transaction", which was wrong in exactly the case that matters.
 *
 * Unlike `recordIssueOccurrence`, there is nothing here that *needs* to share a
 * caller's transaction: a log occurrence has to commit atomically with the raw
 * record it aggregates, whereas metric points reach the store through the
 * batched write queue and are already decoupled from alert state. Batching a
 * whole tick into one transaction would also hold the write lock across
 * hundreds of evaluations, which is precisely what the WAL setup exists to keep
 * short for chart reads. The `db` parameter remains for scratch handles in
 * tests, not for sharing a boundary.
 */
export function recordInfraAlertEvaluation(
  observation: InfraAlertObservation,
  db: Database.Database = getInfraDb(),
): InfraAlertRecordResult {
  if (db.inTransaction) throw new InfraAlertNestedTransactionError('recordInfraAlertEvaluation');
  return db.transaction(() => recordEvaluationLocked(observation, db)).immediate();
}

/** The state machine itself. Always runs with the write lock already held. */
function recordEvaluationLocked(
  observation: InfraAlertObservation,
  db: Database.Database,
): InfraAlertRecordResult {
  const { projectId, ruleId, resourceKey, evaluation, observedAtMs, nowMs } = observation;
  const value = observation.value ?? null;
  const isAlarm = evaluation.state === 'ALARM';

  // Looked up on the natural key rather than filtered by project, so a
  // cross-project pairing is *detected* instead of silently missing and
  // falling through to an insert that would fail the UNIQUE constraint. The
  // guard below is what enforces the isolation.
  const existing = db
    .prepare('SELECT * FROM infra_alerts WHERE rule_id = ? AND resource_key = ?')
    .get(ruleId, resourceKey) as InfraAlertRow | undefined;

  if (existing && existing.project_id !== projectId) {
    throw new InfraAlertProjectMismatchError(projectId, existing.project_id, ruleId);
  }

  // (1) Healthy resource with no history — nothing to say.
  if (!existing && !isAlarm) {
    return {
      alert: null,
      created: false,
      reopened: false,
      autoResolved: false,
      stateChanged: false,
      transitionId: null,
      stale: false,
    };
  }

  // (2) First breach.
  if (!existing) {
    // The check above only covers the update path — with no alert row yet there
    // is nothing carrying a project to compare against, and the foreign key
    // enforces only that the rule *exists*, not that this project owns it.
    // Without this, an observation pairing another project's ruleId with our
    // projectId would insert an alert into our project referencing their rule,
    // and every later evaluation would then pass the existing-row check because
    // the bad row vouches for itself.
    //
    // Deliberately here rather than at the top of the function: this is the
    // only branch that writes a *new* project association, and the collector
    // evaluates (rule x resource) on every tick, the overwhelming majority of
    // which are steady-state rows or healthy no-ops that would pay for a lookup
    // they cannot misuse.
    const owner = db
      .prepare('SELECT project_id FROM infra_alert_rules WHERE id = ?')
      .get(ruleId) as { project_id: string } | undefined;
    if (!owner || owner.project_id !== projectId) {
      throw new InfraAlertProjectMismatchError(projectId, owner?.project_id ?? null, ruleId);
    }

    const id = uuidv4();
    db.prepare(
      `INSERT INTO infra_alerts
         (id, project_id, rule_id, resource_key, state, reason, state_updated_at,
          status, status_updated_at, status_updated_by, first_seen, last_seen,
          occurrence_count, last_value, breaching_datapoints, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(
      id,
      projectId,
      ruleId,
      resourceKey,
      evaluation.state,
      evaluation.reason,
      observedAtMs,
      observedAtMs,
      observedAtMs,
      value,
      evaluation.breachingDatapoints,
      nowMs,
      nowMs,
    );
    const transitionId = appendInfraAlertTransition(db, {
      alertId: id,
      projectId,
      fromState: 'OK',
      toState: evaluation.state,
      fromStatus: 'open',
      toStatus: 'open',
      reason: evaluation.reason,
      actor: INFRA_ALERT_EVALUATOR_ACTOR,
      atMs: nowMs,
    });
    return {
      alert: readAlertById(db, id),
      created: true,
      reopened: false,
      autoResolved: false,
      stateChanged: true,
      transitionId,
      stale: false,
    };
  }

  // Records can arrive out of order — keep the true min/max of the window the
  // alert actually covered, exactly as recordIssueOccurrence does.
  const firstSeen = isAlarm ? Math.min(existing.first_seen, observedAtMs) : existing.first_seen;
  const lastSeen = isAlarm ? Math.max(existing.last_seen, observedAtMs) : existing.last_seen;

  // (3) Stale evaluation: aggregates only, no verdict.
  if (observedAtMs < existing.state_updated_at) {
    if (!isAlarm) {
      return {
        alert: existing,
        created: false,
        reopened: false,
        autoResolved: false,
        stateChanged: false,
        transitionId: null,
        stale: true,
      };
    }
    db.prepare(
      `UPDATE infra_alerts
          SET first_seen = ?, last_seen = ?, occurrence_count = occurrence_count + 1,
              updated_at = ?
        WHERE id = ? AND project_id = ?`,
    ).run(firstSeen, lastSeen, nowMs, existing.id, projectId);
    return {
      alert: readAlertById(db, existing.id),
      created: false,
      reopened: false,
      autoResolved: false,
      stateChanged: false,
      transitionId: null,
      stale: true,
    };
  }

  let status: InfraAlertStatus = existing.status;
  let statusUpdatedAt = existing.status_updated_at;
  let statusUpdatedBy = existing.status_updated_by;
  let reopened = false;
  let autoResolved = false;

  if (isAlarm) {
    // (4) Recurrence reopens a resolved alert; an ignored alert stays muted.
    if (existing.status === 'resolved') {
      status = 'open';
      statusUpdatedAt = nowMs;
      statusUpdatedBy = INFRA_ALERT_RECURRENCE_ACTOR;
      reopened = true;
    }
  } else if (evaluation.state === 'OK' && existing.status === 'open') {
    // (5) Recovery closes it out — and only OK is recovery. INSUFFICIENT_DATA
    // means we could not see the metric, which is not the same claim as "the
    // metric is fine": a broken exporter, a deleted resource or an expired
    // credential all read as INSUFFICIENT_DATA, and auto-resolving on it would
    // silently close a live incident at exactly the moment we stopped being
    // able to observe it. So the state moves (the operator sees the series went
    // dark, and a transition row records it) while the status stays open.
    //
    // Only an open alert: an ignored one stays ignored so muting survives the
    // breach/recover round trip.
    status = 'resolved';
    statusUpdatedAt = nowMs;
    statusUpdatedBy = INFRA_ALERT_RECOVERY_ACTOR;
    autoResolved = true;
  }

  const stateChanged = existing.state !== evaluation.state;

  db.prepare(
    `UPDATE infra_alerts
        SET state = ?, reason = ?, state_updated_at = ?,
            status = ?, status_updated_at = ?, status_updated_by = ?,
            first_seen = ?, last_seen = ?,
            occurrence_count = occurrence_count + ?,
            last_value = ?, breaching_datapoints = ?, updated_at = ?
      WHERE id = ? AND project_id = ?`,
  ).run(
    evaluation.state,
    evaluation.reason,
    observedAtMs,
    status,
    statusUpdatedAt,
    statusUpdatedBy,
    firstSeen,
    lastSeen,
    isAlarm ? 1 : 0,
    value,
    evaluation.breachingDatapoints,
    nowMs,
    existing.id,
    projectId,
  );

  let transitionId: number | null = null;
  if (stateChanged || status !== existing.status) {
    transitionId = appendInfraAlertTransition(db, {
      alertId: existing.id,
      projectId,
      fromState: existing.state,
      toState: evaluation.state,
      fromStatus: existing.status,
      toStatus: status,
      reason: evaluation.reason,
      actor: reopened
        ? INFRA_ALERT_RECURRENCE_ACTOR
        : autoResolved
          ? INFRA_ALERT_RECOVERY_ACTOR
          : INFRA_ALERT_EVALUATOR_ACTOR,
      atMs: nowMs,
    });
  }

  return {
    alert: readAlertById(db, existing.id),
    created: false,
    reopened,
    autoResolved,
    stateChanged,
    transitionId,
    stale: false,
  };
}

function readAlertById(db: Database.Database, alertId: string): InfraAlertRow {
  return db.prepare('SELECT * FROM infra_alerts WHERE id = ?').get(alertId) as InfraAlertRow;
}

interface InfraAlertTransitionInput {
  alertId: string;
  projectId: string;
  fromState: InfraAlarmState;
  toState: InfraAlarmState;
  fromStatus: InfraAlertStatus;
  toStatus: InfraAlertStatus;
  reason: InfraAlarmReason | null;
  actor: string;
  atMs: number;
}

/**
 * Append one transition and trim the alert's history to the retained window.
 *
 * The trim runs on every insert rather than on a schedule because this is the
 * only moment the row count for this alert is already being touched — a
 * periodic sweep would have to re-find the over-long alerts, and a table with
 * no reaper of its own would grow without bound between sweeps.
 */
function appendInfraAlertTransition(
  db: Database.Database,
  input: InfraAlertTransitionInput,
): number {
  const result = db
    .prepare(
      `INSERT INTO infra_alert_transitions
       (alert_id, project_id, from_state, to_state, from_status, to_status, reason, actor, at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.alertId,
      input.projectId,
      input.fromState,
      input.toState,
      input.fromStatus,
      input.toStatus,
      input.reason,
      input.actor,
      input.atMs,
    );
  db.prepare(
    `DELETE FROM infra_alert_transitions
      WHERE alert_id = ?
        AND id NOT IN (
          SELECT id FROM infra_alert_transitions
           WHERE alert_id = ?
           ORDER BY at_ms DESC, id DESC
           LIMIT ?
        )`,
  ).run(input.alertId, input.alertId, INFRA_ALERT_TRANSITION_HISTORY_LIMIT);
  return Number(result.lastInsertRowid);
}

/**
 * Operator-driven status change (resolve / ignore / reopen).
 *
 * Records a transition with the acting user as the actor, so the history reads
 * as one timeline whether a human or the evaluator moved the alert. Returns
 * null when the alert does not exist in this project, which the route turns
 * into a 404 — a cross-project id can never confirm an alert exists.
 *
 * IMMEDIATE for the same reason {@link recordInfraAlertEvaluation} is: this
 * reads the current status, decides against it, then writes. An operator
 * clicking Resolve while a collector tick is recording a recurrence is exactly
 * the interleaving that would otherwise deadlock on a snapshot upgrade — and
 * the same interleaving that would let a decision be made against a status that
 * has already moved.
 *
 * Owns its transaction boundary on the same terms, and throws
 * {@link InfraAlertNestedTransactionError} rather than nesting: a SAVEPOINT
 * inherits the outer locking mode, so the guarantee above would be void exactly
 * when a concurrent writer exists to need it.
 */
export function setInfraAlertStatus(
  projectId: string,
  alertId: string,
  status: InfraAlertStatus,
  actorUserId: string | null,
  nowMs: number,
): InfraAlertRow | null {
  const db = getInfraDb();
  if (db.inTransaction) throw new InfraAlertNestedTransactionError('setInfraAlertStatus');
  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT * FROM infra_alerts WHERE project_id = ? AND id = ?')
        .get(projectId, alertId) as InfraAlertRow | undefined;
      if (!existing) return null;
      if (existing.status === status) return existing;

      db.prepare(
        `UPDATE infra_alerts
          SET status = ?, status_updated_at = ?, status_updated_by = ?, updated_at = ?
        WHERE id = ? AND project_id = ?`,
      ).run(status, nowMs, actorUserId, nowMs, alertId, projectId);

      appendInfraAlertTransition(db, {
        alertId,
        projectId,
        fromState: existing.state,
        toState: existing.state,
        fromStatus: existing.status,
        toStatus: status,
        reason: existing.reason,
        actor: actorUserId ?? 'system:unknown',
        atMs: nowMs,
      });
      return readAlertById(db, alertId);
    })
    .immediate();
}

// ── Alert reads ────────────────────────────────────────────────────────────

export interface InfraAlertListQuery {
  projectId: string;
  status?: InfraAlertStatus;
  state?: InfraAlarmState;
  ruleId?: string;
  resourceKey?: string;
  limit?: number;
  /** Opaque cursor from a prior page (`${last_seen}_${id}`). */
  cursor?: string;
}

export interface InfraAlertListPage {
  alerts: InfraAlertRow[];
  nextCursor: string | null;
  /**
   * Every alert matching the filters, ignoring the page bound.
   *
   * Needed because `alerts.length` is a page size, not a population. A caller
   * rendering "how many alerts are open right now" off the array length reports
   * the page limit once a project exceeds it — an undercount that reads as a
   * quieter system than the operator actually has.
   */
  total: number;
}

function clampAlertLimit(limit: number | undefined): number {
  if (limit == null || !Number.isFinite(limit)) return DEFAULT_INFRA_ALERT_LIST_LIMIT;
  return Math.min(MAX_INFRA_ALERT_LIST_LIMIT, Math.max(1, Math.floor(limit)));
}

function encodeAlertCursor(row: InfraAlertRow): string {
  return `${row.last_seen}_${row.id}`;
}

/**
 * Decode a page cursor, or null when it is unparseable.
 *
 * A malformed cursor reads as "start from the beginning" rather than throwing,
 * matching `listIssues`. The keyset predicate is project-scoped either way, so
 * a cursor minted against another project can only ever skip rows in this one,
 * never surface theirs.
 */
function decodeAlertCursor(cursor: string | undefined): { lastSeen: number; id: string } | null {
  if (!cursor) return null;
  const sep = cursor.indexOf('_');
  if (sep <= 0) return null;
  const lastSeen = Number(cursor.slice(0, sep));
  const id = cursor.slice(sep + 1);
  if (!Number.isFinite(lastSeen) || !id) return null;
  return { lastSeen, id };
}

/** One bounded, keyset-paginated page of alerts, most-recently-seen first. */
export function listInfraAlerts(query: InfraAlertListQuery): InfraAlertListPage {
  const limit = clampAlertLimit(query.limit);
  const clauses = ['project_id = ?'];
  const params: unknown[] = [query.projectId];

  if (query.status) {
    clauses.push('status = ?');
    params.push(query.status);
  }
  if (query.state) {
    clauses.push('state = ?');
    params.push(query.state);
  }
  if (query.ruleId) {
    clauses.push('rule_id = ?');
    params.push(query.ruleId);
  }
  if (query.resourceKey) {
    clauses.push('resource_key = ?');
    params.push(query.resourceKey);
  }
  // Counted before the cursor clause is added, so `total` describes the whole
  // filtered population rather than "the rest of it from here" — a caller
  // paging through must not watch the total shrink under it.
  const total =
    (
      getInfraDb()
        .prepare(`SELECT COUNT(*) AS n FROM infra_alerts WHERE ${clauses.join(' AND ')}`)
        .get(...params) as { n: number } | undefined
    )?.n ?? 0;

  const cursor = decodeAlertCursor(query.cursor);
  if (cursor) {
    clauses.push('(last_seen < ? OR (last_seen = ? AND id < ?))');
    params.push(cursor.lastSeen, cursor.lastSeen, cursor.id);
  }

  // Over-fetch by one so the presence of a next page is known without a
  // second COUNT query.
  const rows = getInfraDb()
    .prepare(
      `SELECT * FROM infra_alerts
        WHERE ${clauses.join(' AND ')}
        ORDER BY last_seen DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as InfraAlertRow[];

  let nextCursor: string | null = null;
  if (rows.length > limit) {
    rows.length = limit;
    nextCursor = encodeAlertCursor(rows[rows.length - 1]);
  }
  return { alerts: rows, nextCursor, total };
}

/** One alert, or null when it does not exist or belongs to another project. */
export function getInfraAlert(projectId: string, alertId: string): InfraAlertRow | null {
  const row = getInfraDb()
    .prepare('SELECT * FROM infra_alerts WHERE project_id = ? AND id = ?')
    .get(projectId, alertId) as InfraAlertRow | undefined;
  return row ?? null;
}

/**
 * Every enabled rule on the Hub, ordered so a sweep is reproducible.
 *
 * Cross-project by design: the evaluation sweep runs once per tick over all of
 * them, the way the collector groups every project's scopes into one pass.
 * Filtering per project would mean the runner first enumerating projects from
 * `projects.json` — a second source of truth for which projects have rules,
 * and one that would silently skip a rule whose project row was renamed.
 */
export function listEnabledInfraAlertRules(projectId?: string): InfraAlertRuleRow[] {
  const clauses = ['enabled = 1'];
  const params: unknown[] = [];
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_rules
        WHERE ${clauses.join(' AND ')}
        ORDER BY project_id, created_at, id`,
    )
    .all(...params) as InfraAlertRuleRow[];
}

/**
 * The alert row for one (rule, resource), or null before the first breach.
 *
 * The evaluation sweep reads this for `previousState`. Null means `OK`: a pair
 * with no row has never breached, which is exactly what
 * {@link recordInfraAlertEvaluation}'s first branch encodes.
 */
export function getInfraAlertForResource(
  ruleId: string,
  resourceKey: string,
): InfraAlertRow | null {
  const row = getInfraDb()
    .prepare('SELECT * FROM infra_alerts WHERE rule_id = ? AND resource_key = ?')
    .get(ruleId, resourceKey) as InfraAlertRow | undefined;
  return row ?? null;
}

/** An alert's transition history, newest first, bounded by the retained window. */
export function listInfraAlertTransitions(
  alertId: string,
  limit = INFRA_ALERT_TRANSITION_HISTORY_LIMIT,
): InfraAlertTransitionRow[] {
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_transitions
        WHERE alert_id = ?
        ORDER BY at_ms DESC, id DESC
        LIMIT ?`,
    )
    .all(
      alertId,
      Math.max(1, Math.min(INFRA_ALERT_TRANSITION_HISTORY_LIMIT, limit)),
    ) as InfraAlertTransitionRow[];
}

/**
 * State-changing transitions whose notification fan-out has not completed.
 *
 * The alert row and this history row commit before the delivery code runs, so
 * the next sweep can recover a process crash in that gap. Status-only history
 * entries are intentionally excluded: notifications are keyed to alarm state
 * changes, not operator/status bookkeeping.
 */
export function listPendingInfraAlertTransitions(
  projectId?: string,
  limit = 100,
): InfraAlertTransitionRow[] {
  const clauses = ['from_state <> to_state', 'notification_delivered_at_ms IS NULL'];
  const params: unknown[] = [];
  if (projectId) {
    clauses.push('project_id = ?');
    params.push(projectId);
  }
  params.push(Math.max(1, Math.min(500, Math.floor(limit))));
  return getInfraDb()
    .prepare(
      `SELECT * FROM infra_alert_transitions
        WHERE ${clauses.join(' AND ')}
        ORDER BY at_ms ASC, id ASC
        LIMIT ?`,
    )
    .all(...params) as InfraAlertTransitionRow[];
}

/** Mark one state-changing transition's notification intent as delivered. */
export function markInfraAlertTransitionNotificationDelivered(
  transitionId: number,
  deliveredAtMs = Date.now(),
): boolean {
  return (
    getInfraDb()
      .prepare(
        `UPDATE infra_alert_transitions
            SET notification_delivered_at_ms = ?
          WHERE id = ?
            AND from_state <> to_state
            AND notification_delivered_at_ms IS NULL`,
      )
      .run(deliveredAtMs, transitionId).changes > 0
  );
}

// ── Serialization ──────────────────────────────────────────────────────────

/**
 * Rule row → API body.
 *
 * `tagFilter` is re-parsed to an object rather than passed through as a string
 * so the client never has to JSON.parse a field of a JSON document. A row whose
 * stored JSON is unparseable degrades to null rather than throwing: a corrupt
 * filter should make one rule render without its predicate, not take down the
 * whole rules list.
 */
export function serializeInfraAlertRule(row: InfraAlertRuleRow): Record<string, unknown> {
  let tagFilter: Record<string, string[]> | null = null;
  if (row.tag_filter_json) {
    try {
      tagFilter = JSON.parse(row.tag_filter_json) as Record<string, string[]>;
    } catch {
      tagFilter = null;
    }
  }
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    service: row.service,
    accountId: row.account_id,
    region: row.region,
    resourceKey: row.resource_key,
    tagFilter,
    namespace: row.namespace,
    metricName: row.metric_name,
    stat: row.stat,
    periodS: row.period_s,
    threshold: row.threshold,
    comparisonOperator: row.comparison_operator,
    evaluationPeriods: row.evaluation_periods,
    datapointsToAlarm: row.datapoints_to_alarm,
    treatMissingData: row.treat_missing_data,
    severity: row.severity,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Transition row → API body. */
export function serializeInfraAlertTransition(
  row: InfraAlertTransitionRow,
): Record<string, unknown> {
  return {
    fromState: row.from_state,
    toState: row.to_state,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actor: row.actor,
    atMs: row.at_ms,
  };
}

/** Alert row → API body, optionally with its transition history attached. */
export function serializeInfraAlert(
  row: InfraAlertRow,
  transitions?: InfraAlertTransitionRow[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: row.id,
    projectId: row.project_id,
    ruleId: row.rule_id,
    resourceKey: row.resource_key,
    state: row.state,
    reason: row.reason,
    stateUpdatedAt: row.state_updated_at,
    status: row.status,
    statusUpdatedAt: row.status_updated_at,
    statusUpdatedBy: row.status_updated_by,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    occurrenceCount: row.occurrence_count,
    lastValue: row.last_value,
    breachingDatapoints: row.breaching_datapoints,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (transitions) body.transitions = transitions.map(serializeInfraAlertTransition);
  return body;
}

// Re-exported so callers import the alert vocabulary from the store they use,
// rather than reaching past it into the schema module for an enum.
export {
  INFRA_ALERT_SEVERITIES,
  INFRA_ALERT_STATUSES,
  MAX_INFRA_ALERT_LIST_LIMIT,
  DEFAULT_INFRA_ALERT_LIST_LIMIT,
  INFRA_ALERT_RECURRENCE_ACTOR,
  INFRA_ALERT_RECOVERY_ACTOR,
  INFRA_ALERT_EVALUATOR_ACTOR,
  type InfraAlertSeverity,
  type InfraAlertStatus,
};
