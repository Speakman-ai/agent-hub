/**
 * alert-runner.ts — the sweep that feeds the pure evaluator (decision
 * INFRA-ALERT).
 *
 * Three modules split alerting along one seam and this is the third:
 * `alert-evaluator.ts` is pure and answers "what state does this range put this
 * rule in"; `alert-store.ts` owns every row and every transition; this module is
 * the only one that holds a clock, expands a rule's selector into resources,
 * and reads the series out of `infra_metric_points`.
 *
 * It runs immediately after a collector tick has been flushed rather than on an
 * independent cron. The ordering is the point: metric points reach the store
 * through a batched write queue, so an evaluator sweep on its own schedule would
 * routinely read the window *before* the tick that filled it and manufacture a
 * missing datapoint at the newest slot. Chaining it to the collector also means
 * a project paused on its cost ceiling stops evaluating instead of walking every
 * alarm into INSUFFICIENT_DATA and back once the spend resets — an alarm should
 * not page because we stopped looking.
 *
 * ## This module owns the evaluation range length
 *
 * `alert-evaluator.ts` deliberately does not compute one; its header explains
 * why, and hands the choice to this ticket. CloudWatch "attempts to retrieve a
 * higher number of data points than the number specified as Evaluation Periods"
 * and publishes no formula for how many. The only concrete figure in AWS's
 * documentation is the worked example where Evaluation Periods is 3 and "5 is
 * the evaluation range for the alarm", so the range here is
 * **N + {@link EVALUATION_RANGE_PADDING}**, which reproduces that example.
 *
 * The padding is load-bearing in both directions and cannot be dropped to zero
 * as a simplification. Too short invents alarms (a range of exactly N loses the
 * non-breaching datapoint that suppresses the premature-alarm rule), too long
 * suppresses real ones. It also buys the tolerance that makes ingestion lag
 * harmless: with two spare slots, a trailing period CloudWatch has not published
 * yet still leaves N real datapoints, and AWS's own rule is that the treatment
 * is "not needed and is ignored" once N real datapoints exist. Overridable per
 * run so a deployment that diffs us against the console can tune it without a
 * code change.
 *
 * ## A rule is evaluated against exactly one series
 *
 * `(project, resource, metric)` does not name a series — `namespace`, `stat`,
 * `period_s` and `dimensions_hash` do too. Alert rules do not carry dimensions
 * yet, so {@link resolveSeriesDimensionsHash} picks the one series a rule reads
 * before any bucketing happens, and refuses rather than guessing when the choice
 * is genuinely ambiguous. Reading the union instead would decide the value in a
 * slot by row order and let the row limit truncate whichever series lost — both
 * of which produce a verdict about numbers nobody chose.
 */

import {
  evaluateInfraAlarm,
  type InfraAlarmEvaluation,
  type InfraAlarmState,
} from './alert-evaluator.js';
import {
  getInfraAlertForResource,
  listEnabledInfraAlertRules,
  recordInfraAlertEvaluation,
  toThresholdRule,
  type InfraAlertRecordResult,
  type InfraAlertRuleRow,
} from './alert-store.js';
import { getInfraDb, isInfraDbInitialized, parseInfraResourceKey } from './infra-db.js';
import {
  infraDimensionsHash,
  queryInfraMetricPoints,
  type InfraMetricPointRow,
} from './infra-metric-store.js';
import { getServiceMetricPack } from './service-metric-packs.js';
// Shared with the collector on purpose, not copied: the set of resources a rule
// evaluates must be the set the collector is fetching data for. If the two
// staleness bounds ever diverge, every resource in the gap evaluates against a
// series nothing is filling and walks into INSUFFICIENT_DATA.
import { MAX_RESOURCE_STALENESS_MS } from './metric-collector.js';
import {
  compileInfraTagFilter,
  isEmptyInfraTagFilter,
  matchesInfraTagFilter,
} from './tag-filter.js';
import type { BroadcastFn } from '../types.js';

/**
 * Slots fetched beyond N. See the module header — this reproduces AWS's only
 * published evaluation-range figure (N=3 → range 5).
 */
export const EVALUATION_RANGE_PADDING = 2;

/** The subset of an `infra_resources` row a rule is evaluated against. */
export interface AlertableResource {
  resource_key: string;
  resource_id: string;
  tags_json?: string | null;
}

export interface InfraAlertEvaluationOptions {
  /** Injected clock so tests can pin the range. */
  nowMs?: number;
  /**
   * In-app notice sink for a state transition (decisions INFRA-NOTIFY /
   * INFRA-UI). Optional so a test — or a Hub with no WebSocket server — degrades
   * to persistence only rather than throwing inside the sweep.
   */
  broadcast?: BroadcastFn;
  /** Evaluate one project's rules only. Defaults to every project. */
  projectId?: string;
  /** Override {@link EVALUATION_RANGE_PADDING} for this run. */
  rangePadding?: number;
}

export interface InfraAlertEvaluationResult {
  /** Enabled rules the sweep considered. */
  rules: number;
  /** (rule, resource) pairs handed to the evaluator. */
  evaluations: number;
  /** Rules whose selector matched no resource. */
  rulesWithoutResources: number;
  /** State changes the store recorded — the notification count. */
  transitions: number;
  created: number;
  reopened: number;
  autoResolved: number;
  /** Evaluations older than the stored state; aggregates only, no verdict. */
  stale: number;
  /** Rules skipped whole: unevaluable threshold, malformed tag filter, bad SQL. */
  ruleErrors: number;
  /** Single (rule, resource) pairs that failed; the rest of the rule continued. */
  resourceErrors: number;
  /**
   * Subset of `resourceErrors` refused because the metric reports under several
   * dimension sets and the rule names none of them.
   */
  ambiguousSeries: number;
  /** Broadcasts that threw and were swallowed. */
  broadcastErrors: number;
}

function emptyResult(): InfraAlertEvaluationResult {
  return {
    rules: 0,
    evaluations: 0,
    rulesWithoutResources: 0,
    transitions: 0,
    created: 0,
    reopened: 0,
    autoResolved: 0,
    stale: 0,
    ruleErrors: 0,
    resourceErrors: 0,
    ambiguousSeries: 0,
    broadcastErrors: 0,
  };
}

/** Range length in periods for a rule with `evaluationPeriods` = N. */
export function evaluationRangeLength(evaluationPeriods: number, padding: number): number {
  return Math.max(1, Math.floor(evaluationPeriods)) + Math.max(0, Math.floor(padding));
}

/**
 * Resources one rule evaluates against.
 *
 * The selector is a *predicate* over `infra_resources`, not a resource list, so
 * a rule covering "every EC2 instance in us-east-2" picks up an instance
 * inventory sync discovers tomorrow without being edited.
 *
 * A rule pinned to one `resource_key` bypasses the inventory entirely: an alert
 * must survive its resource ageing out of the table (that is why `infra_alerts`
 * carries no foreign key to it), and a pinned rule going quiet because the
 * describe sweep has not run yet would be indistinguishable from a healthy
 * metric.
 *
 * Throws on a malformed tag filter, and the caller counts the rule as failed.
 * Fail-closed for the same reason the collector's copy fails closed: falling
 * back to "no filter" turns an operator typo into every resource in the region
 * being alarmed on.
 */
export function listRuleResources(rule: InfraAlertRuleRow, nowMs: number): AlertableResource[] {
  if (rule.resource_key) {
    const pinned = getInfraDb()
      .prepare(
        `SELECT resource_key, resource_id, tags_json
           FROM infra_resources
          WHERE project_id = ? AND resource_key = ?`,
      )
      .get(rule.project_id, rule.resource_key) as AlertableResource | undefined;
    if (pinned) return [pinned];
    // No inventory row: recover the bare resource id from the key rather than
    // falling back to the key itself. The key embeds the AWS account id, so
    // using it as a resource id would both build a dimension set that matches
    // no series and put the account id into a broadcast that fans out to every
    // connected client (decision INFRA-NOTIFY).
    const identity = parseInfraResourceKey(rule.resource_key);
    if (!identity) {
      throw new Error(
        `alert rule ${rule.id} pins an unparseable resource_key; it was not minted by ` +
          'infraResourceKey()',
      );
    }
    return [{ resource_key: rule.resource_key, resource_id: identity.resourceId }];
  }

  const tagFilter = compileInfraTagFilter(rule.tag_filter_json);
  const clauses = [
    'project_id = ?',
    'service = ?',
    'last_seen >= ?',
    "(state IS NULL OR state != 'terminated')",
  ];
  const params: (string | number)[] = [
    rule.project_id,
    rule.service,
    nowMs - MAX_RESOURCE_STALENESS_MS,
  ];
  // NULL means "any" on both columns, so a rule narrows from a whole service
  // down to one region or account without a schema change.
  if (rule.account_id) {
    clauses.push('account_id = ?');
    params.push(rule.account_id);
  }
  if (rule.region) {
    clauses.push('region = ?');
    params.push(rule.region);
  }
  const rows = getInfraDb()
    .prepare(
      `SELECT resource_key, resource_id, tags_json
         FROM infra_resources
        WHERE ${clauses.join(' AND ')}
        ORDER BY resource_id`,
    )
    .all(...params) as AlertableResource[];

  if (isEmptyInfraTagFilter(tagFilter)) return rows;
  return rows.filter((row) => matchesInfraTagFilter(row.tags_json ?? null, tagFilter));
}

/** One resource's evaluation range, ready for the evaluator. */
export interface MetricEvaluationRange {
  /** One slot per period, oldest first, `null` for a period with no datapoint. */
  datapoints: (number | null)[];
  /** Newest real datapoint's value, or null when the range is empty. */
  latestValue: number | null;
  /**
   * Newest real datapoint's timestamp, or the range end when there is none.
   * This is the *data's* clock, which the store orders racing evaluations by.
   */
  observedAtMs: number;
  /** Inclusive start of the oldest slot. */
  rangeStartMs: number;
  /** Exclusive end of the newest slot — the last fully elapsed period boundary. */
  rangeEndMs: number;
}

/**
 * Bucket stored points into period slots, oldest first.
 *
 * CloudWatch timestamps a datapoint at the *start* of its period, and that is
 * what the collector stores, so slot `i` owns the half-open interval
 * `[rangeEnd - (len - i) * period, + period)`. The newest slot ends at the last
 * fully elapsed period boundary: the period in progress is by definition
 * incomplete, and evaluating it would compare a partial aggregate to a threshold
 * tuned for a whole one.
 *
 * Pure, so the bucketing can be tested without a database.
 *
 * **Callers must hand this one series.** `resolveSeriesDimensionsHash()` is what
 * guarantees that, and the guarantee is load-bearing: collapsing two dimension
 * sets into one slot would silently pick a value by row order. This function
 * stays defensive anyway — the newest timestamp wins a slot, never "last one
 * seen" — so a future caller that widens the read degrades to a deterministic
 * answer rather than an arbitrary one.
 */
export function bucketPointsIntoSlots(
  points: readonly InfraMetricPointRow[],
  rangeEndMs: number,
  periodMs: number,
  slotCount: number,
): MetricEvaluationRange {
  const rangeStartMs = rangeEndMs - slotCount * periodMs;
  const datapoints: (number | null)[] = new Array(slotCount).fill(null);
  const slotTsMs: (number | null)[] = new Array(slotCount).fill(null);
  let latestValue: number | null = null;
  let latestTsMs: number | null = null;

  for (const point of points) {
    if (point.tsMs < rangeStartMs || point.tsMs >= rangeEndMs) continue;
    if (!Number.isFinite(point.value)) continue;
    const slot = Math.floor((point.tsMs - rangeStartMs) / periodMs);
    if (slot < 0 || slot >= slotCount) continue;
    const heldTs = slotTsMs[slot];
    if (heldTs !== null && heldTs >= point.tsMs) continue;
    slotTsMs[slot] = point.tsMs;
    datapoints[slot] = point.value;
    if (latestTsMs === null || point.tsMs > latestTsMs) {
      latestTsMs = point.tsMs;
      latestValue = point.value;
    }
  }

  return {
    datapoints,
    latestValue,
    // No real datapoint still needs a monotonic clock, or a series that goes
    // dark would keep re-recording the same observation timestamp and every
    // evaluation after the first would be discarded as stale.
    observedAtMs: latestTsMs ?? rangeEndMs,
    rangeStartMs,
    rangeEndMs,
  };
}

/**
 * A (rule, resource) whose series cannot be identified without guessing.
 *
 * A distinct class so the sweep can log it as the operator-actionable
 * configuration problem it is, rather than as a generic evaluation failure.
 */
export class AmbiguousMetricSeriesError extends Error {
  constructor(
    readonly ruleId: string,
    readonly resourceKey: string,
    readonly dimensionsHashes: string[],
  ) {
    super(
      `rule ${ruleId} matches ${dimensionsHashes.length} dimension sets on ${resourceKey} ` +
        `(${dimensionsHashes.join(', ')}) and none is the one its service metric pack ` +
        'collects; the rule cannot be evaluated without choosing a series arbitrarily',
    );
    this.name = 'AmbiguousMetricSeriesError';
  }
}

/**
 * Pick the one series a rule evaluates on, or null when the window is empty.
 *
 * **This is the reason the sweep is not free to just read `(project, resource,
 * metric)`.** That triple names a series only once `namespace`, `stat`,
 * `period_s` *and* `dimensions_hash` are pinned. A metric reported under more
 * than one dimension set — an ALB per-AZ series alongside the load-balancer
 * total, a future pack entry adding a dimension — would otherwise interleave
 * into one slot array, where the value that survives is decided by row order
 * and the row limit truncates whichever series lost the race. Either produces a
 * verdict that is silently about the wrong numbers.
 *
 * CloudWatch's own rule is that an alarm names one fully-specified dimension
 * set; a partially-specified one simply returns no data. Our rules do not carry
 * dimensions yet (that is a schema change, tracked separately), so the series is
 * resolved here, in this order:
 *
 *   1. **One dimension set present** — unambiguous, use it. This is every rule
 *      on today's packs, which plan exactly one dimension per (metric, stat).
 *      Taking the observed set rather than the pack's also means a pack whose
 *      dimension name changed keeps evaluating against the data we actually
 *      collected instead of going quietly dark.
 *   2. **Several present** — prefer the set this rule's service metric pack
 *      collects, which is the series the collector deliberately asked for.
 *   3. **Several, none from the pack** — refuse. Throwing costs this pair its
 *      tick and is counted; guessing would page on a number nobody chose.
 *
 * The distinct-hash probe is a second query rather than a wider read of the
 * points themselves, because only a probe can be *bounded and complete*: a
 * single wide read would need a row limit, and a limit is exactly what silently
 * truncates a series here.
 */
export function resolveSeriesDimensionsHash(
  rule: InfraAlertRuleRow,
  resource: AlertableResource,
  rangeStartMs: number,
  rangeEndMs: number,
): string | null {
  const rows = getInfraDb()
    .prepare(
      `SELECT DISTINCT dimensions_hash
         FROM infra_metric_points
        WHERE project_id = ? AND resource_key = ? AND metric_name = ?
          AND namespace = ? AND stat = ? AND period_s = ?
          AND ts_ms >= ? AND ts_ms < ?
        ORDER BY dimensions_hash`,
    )
    .all(
      rule.project_id,
      resource.resource_key,
      rule.metric_name,
      rule.namespace,
      rule.stat,
      rule.period_s,
      rangeStartMs,
      rangeEndMs,
    ) as { dimensions_hash: string }[];

  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0].dimensions_hash;

  const spec = getServiceMetricPack(rule.service).find(
    (s) =>
      s.namespace === rule.namespace && s.metricName === rule.metric_name && s.stat === rule.stat,
  );
  if (spec) {
    const packHash = infraDimensionsHash({ [spec.dimension]: resource.resource_id });
    if (rows.some((r) => r.dimensions_hash === packHash)) return packHash;
  }
  throw new AmbiguousMetricSeriesError(
    rule.id,
    resource.resource_key,
    rows.map((r) => r.dimensions_hash),
  );
}

/** Read and bucket one (rule, resource) evaluation range. */
export function readEvaluationRange(
  rule: InfraAlertRuleRow,
  resource: AlertableResource,
  nowMs: number,
  padding: number,
): MetricEvaluationRange {
  const periodMs = Math.max(1, Math.floor(rule.period_s)) * 1000;
  const slotCount = evaluationRangeLength(rule.evaluation_periods, padding);
  const rangeEndMs = Math.floor(nowMs / periodMs) * periodMs;
  const rangeStartMs = rangeEndMs - slotCount * periodMs;

  const dimensionsHash = resolveSeriesDimensionsHash(rule, resource, rangeStartMs, rangeEndMs);
  // Nothing reported in the window. An empty range is a legitimate input — the
  // treatment decides what an all-missing range means — and skipping the read
  // saves a query on every dark series.
  if (dimensionsHash === null) {
    return bucketPointsIntoSlots([], rangeEndMs, periodMs, slotCount);
  }

  const points = queryInfraMetricPoints({
    projectId: rule.project_id,
    resourceKey: resource.resource_key,
    metricName: rule.metric_name,
    namespace: rule.namespace,
    stat: rule.stat,
    // Pinned so the read cannot interleave the 60s/300s/3600s tiers the
    // collector legitimately stores the same metric at.
    periodSeconds: rule.period_s,
    // The last filter needed to name exactly one series, so the row limit below
    // cannot truncate a competing one.
    dimensionsHash,
    startMs: rangeStartMs,
    endMs: rangeEndMs - 1,
    // One series at one period yields at most one row per slot — the store's
    // unique index is (series, period, timestamp) — so this limit is exact
    // rather than a guess with headroom.
    limit: slotCount,
  });

  return bucketPointsIntoSlots(points, rangeEndMs, periodMs, slotCount);
}

/**
 * The WebSocket payload for one transition (decisions INFRA-NOTIFY / INFRA-UI).
 *
 * Deliberately thin. A broadcast fans out to **every** connected client of the
 * project while the alert routes themselves are Admin-gated, so this carries
 * only what a toast and a badge need, and the client re-reads the alert through
 * the gated REST route for anything more. In particular it carries `resourceId`
 * (the bare instance id / load balancer name) and never `resourceKey`, which
 * encodes the AWS account id, nor the rule's account or region selector.
 */
export function buildTransitionBroadcast(
  rule: InfraAlertRuleRow,
  resource: AlertableResource,
  record: InfraAlertRecordResult,
  evaluation: InfraAlarmEvaluation,
  previousState: InfraAlarmState,
  value: number | null,
): Record<string, unknown> {
  return {
    type: 'infra_alert_transition',
    projectId: rule.project_id,
    alertId: record.alert?.id ?? null,
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity,
    service: rule.service,
    metricName: rule.metric_name,
    resourceId: resource.resource_id,
    fromState: previousState,
    toState: evaluation.state,
    reason: evaluation.reason,
    status: record.alert?.status ?? null,
    created: record.created,
    reopened: record.reopened,
    autoResolved: record.autoResolved,
    value,
    breachingDatapoints: evaluation.breachingDatapoints,
    at: evaluation.evaluatedAtMs,
  };
}

/**
 * Evaluate one rule against one resource and fold the verdict into the store.
 *
 * Returns the record result so the caller can count it, or throws — the caller
 * isolates the failure to this pair.
 */
function evaluateResource(
  rule: InfraAlertRuleRow,
  resource: AlertableResource,
  nowMs: number,
  opts: InfraAlertEvaluationOptions,
  result: InfraAlertEvaluationResult,
): void {
  const padding = opts.rangePadding ?? EVALUATION_RANGE_PADDING;
  const range = readEvaluationRange(rule, resource, nowMs, padding);

  // No row means the pair has never breached, which is what the store's
  // "healthy resource with no history" branch encodes as OK.
  const existing = getInfraAlertForResource(rule.id, resource.resource_key);
  const previousState: InfraAlarmState = existing?.state ?? 'OK';

  const evaluation = evaluateInfraAlarm({
    rule: toThresholdRule(rule),
    datapoints: range.datapoints,
    previousState,
    evaluatedAtMs: nowMs,
  });

  const record = recordInfraAlertEvaluation({
    projectId: rule.project_id,
    ruleId: rule.id,
    resourceKey: resource.resource_key,
    evaluation,
    observedAtMs: range.observedAtMs,
    value: range.latestValue,
    nowMs,
  });

  result.evaluations += 1;
  if (record.created) result.created += 1;
  if (record.reopened) result.reopened += 1;
  if (record.autoResolved) result.autoResolved += 1;
  if (record.stale) result.stale += 1;

  // `record.stateChanged`, not `evaluation.transitioned`, is the notification
  // signal. The two differ in exactly the cases that matter: a stale evaluation
  // has a transition the store refused to apply, and an INSUFFICIENT_DATA
  // verdict on a pair with no alert row transitions from the assumed OK without
  // opening an incident. Notifying off the evaluator would page on both.
  if (!record.stateChanged) return;
  result.transitions += 1;
  if (!opts.broadcast) return;
  try {
    opts.broadcast(
      buildTransitionBroadcast(
        rule,
        resource,
        record,
        evaluation,
        previousState,
        range.latestValue,
      ),
    );
  } catch (err) {
    // A WebSocket fan-out failure must not lose the persisted transition or
    // abort the sweep. The row is already committed; the client re-reads it.
    result.broadcastErrors += 1;
    console.warn(
      `[infra-alert-runner] broadcast failed for rule ${rule.id}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Run one evaluation sweep across every enabled rule.
 *
 * Never throws — same contract as the collector tick and inventory sync, and
 * for the same reason. One rule with an unevaluable threshold (say
 * `datapointsToAlarm` above `evaluationPeriods`, which the evaluator refuses
 * rather than silently repairs) or a malformed tag filter must cost that rule
 * its tick, not the whole fleet its alerting. Isolation is two-level: a rule
 * whose resource expansion fails is skipped whole, and inside a rule each
 * resource is independent.
 */
export function runInfraAlertEvaluation(
  opts: InfraAlertEvaluationOptions = {},
): InfraAlertEvaluationResult {
  const result = emptyResult();
  // Scheduled unconditionally at boot, but infra.db only exists once
  // initInfraDb() has run. A no-op beats a thrown tick.
  if (!isInfraDbInitialized()) return result;

  const nowMs = opts.nowMs ?? Date.now();

  let rules: InfraAlertRuleRow[];
  try {
    rules = listEnabledInfraAlertRules(opts.projectId);
  } catch (err) {
    console.warn(
      '[infra-alert-runner] could not load rules:',
      err instanceof Error ? err.message : String(err),
    );
    return result;
  }
  result.rules = rules.length;

  for (const rule of rules) {
    let resources: AlertableResource[];
    try {
      resources = listRuleResources(rule, nowMs);
    } catch (err) {
      result.ruleErrors += 1;
      console.warn(
        `[infra-alert-runner] rule ${rule.id} (${rule.project_id}) resource selection failed:`,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    if (resources.length === 0) {
      result.rulesWithoutResources += 1;
      continue;
    }

    let ruleFailed = false;
    for (const resource of resources) {
      try {
        evaluateResource(rule, resource, nowMs, opts, result);
      } catch (err) {
        result.resourceErrors += 1;
        // Counted separately because it is not a bug but an operator-actionable
        // configuration gap: this metric reports under several dimension sets
        // and the rule has no way to say which one it means.
        if (err instanceof AmbiguousMetricSeriesError) result.ambiguousSeries += 1;
        // A rule the evaluator refuses fails identically on every one of its
        // resources, so log it once and move to the next rule rather than
        // emitting one line per instance in a fleet.
        if (!ruleFailed) {
          ruleFailed = true;
          console.warn(
            `[infra-alert-runner] rule ${rule.id} (${rule.project_id}) failed on ` +
              `${resource.resource_id}:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  return result;
}
