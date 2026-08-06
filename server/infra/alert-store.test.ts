/**
 * Alert store: rule CRUD, and the lifecycle state machine that has to match
 * `log-issues-store.ts` — recurrence reopens a resolved alert, `ignored` stays
 * muted through a full breach/recover round trip, and out-of-order
 * observations keep the true min/max window without rewriting a newer verdict.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb } from './infra-db.js';
import {
  createInfraAlertRule,
  getInfraAlertRule,
  listInfraAlertRules,
  updateInfraAlertRule,
  deleteInfraAlertRule,
  toThresholdRule,
  recordInfraAlertEvaluation,
  setInfraAlertStatus,
  listInfraAlerts,
  getInfraAlert,
  listInfraAlertTransitions,
  serializeInfraAlert,
  serializeInfraAlertRule,
  InfraAlertRuleValidationError,
  InfraAlertProjectMismatchError,
  InfraAlertNestedTransactionError,
  type InfraAlertRuleInput,
} from './alert-store.js';
import {
  INFRA_ALERT_RECURRENCE_ACTOR,
  INFRA_ALERT_RECOVERY_ACTOR,
  INFRA_ALERT_TRANSITION_HISTORY_LIMIT,
} from './infra-schema.js';
import type { InfraAlarmEvaluation, InfraAlarmState } from './alert-evaluator.js';

let dir: string;

const PROJECT = 'proj-alerts';
const RESOURCE = 'proj-alerts|123456789012|us-east-2|ec2|i-0abc';
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const MINUTE = 60_000;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-alert-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function ruleInput(overrides: Partial<InfraAlertRuleInput> = {}): InfraAlertRuleInput {
  return {
    name: 'EC2 CPU high',
    service: 'ec2',
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    periodS: 300,
    threshold: 90,
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 3,
    ...overrides,
  };
}

/** A verdict shaped like the evaluator's, without running it. */
function evaluation(
  state: InfraAlarmState,
  overrides: Partial<InfraAlarmEvaluation> = {},
): InfraAlarmEvaluation {
  return {
    state,
    previousState: 'OK',
    transitioned: true,
    reason: state === 'ALARM' ? 'datapoints_breached' : 'within_threshold',
    evaluatedAtMs: NOW,
    realDatapoints: 3,
    filledDatapoints: 0,
    breachingDatapoints: state === 'ALARM' ? 3 : 0,
    ...overrides,
  };
}

function fire(
  ruleId: string,
  state: InfraAlarmState,
  observedAtMs: number,
  opts: { nowMs?: number; value?: number } = {},
) {
  return recordInfraAlertEvaluation({
    projectId: PROJECT,
    ruleId,
    resourceKey: RESOURCE,
    evaluation: evaluation(state),
    observedAtMs,
    value: opts.value ?? null,
    nowMs: opts.nowMs ?? observedAtMs,
  });
}

function seedRule(overrides: Partial<InfraAlertRuleInput> = {}): string {
  return createInfraAlertRule(PROJECT, ruleInput(overrides), NOW).id;
}

describe('alert rule CRUD', () => {
  it('stores a rule with the documented defaults filled in', () => {
    const rule = createInfraAlertRule(PROJECT, ruleInput(), NOW);

    expect(rule.datapoints_to_alarm).toBeNull();
    expect(rule.treat_missing_data).toBe('missing');
    expect(rule.severity).toBe('warning');
    expect(rule.enabled).toBe(1);
    // The threshold projection is what the pure evaluator consumes: a null
    // datapointsToAlarm has to stay null so the evaluator applies its own
    // documented default of N rather than the store guessing one.
    expect(toThresholdRule(rule)).toEqual({
      comparisonOperator: 'GreaterThanThreshold',
      threshold: 90,
      evaluationPeriods: 3,
      datapointsToAlarm: null,
      treatMissingData: 'missing',
    });
  });

  it('rejects a rule that could never reach ALARM', () => {
    expect(() =>
      createInfraAlertRule(PROJECT, ruleInput({ evaluationPeriods: 2, datapointsToAlarm: 5 }), NOW),
    ).toThrow(InfraAlertRuleValidationError);
  });

  it('checks the M-of-N invariant against the merged rule, not the patch', () => {
    const id = seedRule({ evaluationPeriods: 5, datapointsToAlarm: 4 });

    // The patch alone looks harmless — it is only invalid once merged with the
    // datapointsToAlarm a previous request set.
    expect(() => updateInfraAlertRule(PROJECT, id, { evaluationPeriods: 2 }, NOW)).toThrow(
      InfraAlertRuleValidationError,
    );
    expect(getInfraAlertRule(PROJECT, id)?.evaluation_periods).toBe(5);
  });

  it('stores an empty tag filter as no filter at all', () => {
    const withEmpty = createInfraAlertRule(PROJECT, ruleInput({ tagFilter: {} }), NOW);
    expect(withEmpty.tag_filter_json).toBeNull();
    expect(serializeInfraAlertRule(withEmpty).tagFilter).toBeNull();

    const withFilter = createInfraAlertRule(
      PROJECT,
      ruleInput({ tagFilter: { Environment: ['prod'] } }),
      NOW,
    );
    expect(serializeInfraAlertRule(withFilter).tagFilter).toEqual({ Environment: ['prod'] });
  });

  it('leaves absent patch keys alone and round-trips enabled', () => {
    const id = seedRule();
    const updated = updateInfraAlertRule(PROJECT, id, { enabled: false }, NOW + 1);

    expect(updated?.enabled).toBe(0);
    expect(updated?.name).toBe('EC2 CPU high');
    expect(updated?.threshold).toBe(90);
    expect(listInfraAlertRules({ projectId: PROJECT, enabled: false })).toHaveLength(1);
    expect(listInfraAlertRules({ projectId: PROJECT, enabled: true })).toHaveLength(0);
  });

  it('scopes every rule read and write to the project', () => {
    const id = seedRule();

    expect(getInfraAlertRule('other-project', id)).toBeNull();
    expect(updateInfraAlertRule('other-project', id, { name: 'stolen' }, NOW)).toBeNull();
    expect(deleteInfraAlertRule('other-project', id)).toBe(false);
    expect(getInfraAlertRule(PROJECT, id)?.name).toBe('EC2 CPU high');
  });

  it('cascades alerts and their history when a rule is deleted', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;

    expect(deleteInfraAlertRule(PROJECT, ruleId)).toBe(true);
    expect(getInfraAlert(PROJECT, alertId)).toBeNull();
    expect(listInfraAlertTransitions(alertId)).toHaveLength(0);
  });
});

describe('alert lifecycle', () => {
  it('does not create a row for a resource that never breached', () => {
    const ruleId = seedRule();
    const result = fire(ruleId, 'OK', NOW);

    expect(result.alert).toBeNull();
    expect(result.created).toBe(false);
    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(0);
  });

  it('opens an alert on the first breach and records the transition', () => {
    const ruleId = seedRule();
    const result = fire(ruleId, 'ALARM', NOW, { value: 97 });

    expect(result.created).toBe(true);
    expect(result.stateChanged).toBe(true);
    expect(result.alert).toMatchObject({
      state: 'ALARM',
      status: 'open',
      first_seen: NOW,
      last_seen: NOW,
      occurrence_count: 1,
      last_value: 97,
    });

    expect(listInfraAlertTransitions(result.alert!.id)).toMatchObject([
      { from_state: 'OK', to_state: 'ALARM', from_status: 'open', to_status: 'open' },
    ]);
  });

  it('auto-resolves an open alert when the metric recovers', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    const recovered = fire(ruleId, 'OK', NOW + MINUTE);

    expect(recovered.autoResolved).toBe(true);
    expect(recovered.alert).toMatchObject({
      state: 'OK',
      status: 'resolved',
      status_updated_by: INFRA_ALERT_RECOVERY_ACTOR,
    });
  });

  it('does not auto-resolve an open alert when the metric goes dark', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);

    // INSUFFICIENT_DATA is "we could not see it", not "it recovered". A broken
    // exporter or an expired credential must not close a live incident at the
    // moment we stop being able to observe it.
    const dark = fire(ruleId, 'INSUFFICIENT_DATA', NOW + MINUTE);

    expect(dark.autoResolved).toBe(false);
    expect(dark.stateChanged).toBe(true);
    expect(dark.alert).toMatchObject({
      state: 'INSUFFICIENT_DATA',
      status: 'open',
      // Untouched by the evaluator — still whatever the operator last set.
      status_updated_by: null,
    });

    // The state move is still recorded, so the operator can see the series
    // went dark rather than the alert simply going quiet.
    expect(listInfraAlertTransitions(dark.alert!.id)[0]).toMatchObject({
      from_state: 'ALARM',
      to_state: 'INSUFFICIENT_DATA',
      from_status: 'open',
      to_status: 'open',
    });
  });

  it('resolves once the metric actually recovers after going dark', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    fire(ruleId, 'INSUFFICIENT_DATA', NOW + MINUTE);

    const recovered = fire(ruleId, 'OK', NOW + 2 * MINUTE);

    expect(recovered.autoResolved).toBe(true);
    expect(recovered.alert).toMatchObject({
      state: 'OK',
      status: 'resolved',
      status_updated_by: INFRA_ALERT_RECOVERY_ACTOR,
    });
  });

  it('does not open an alert for a resource that is merely unobservable', () => {
    const ruleId = seedRule();
    // An operator who wants missing data to page says so on the rule via
    // treatMissingData: 'breaching', and the evaluator then hands us ALARM.
    const result = fire(ruleId, 'INSUFFICIENT_DATA', NOW);

    expect(result.alert).toBeNull();
    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(0);
  });

  it('reopens a resolved alert on recurrence, attributed to the recurrence actor', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    fire(ruleId, 'OK', NOW + MINUTE);

    const recurrence = fire(ruleId, 'ALARM', NOW + 2 * MINUTE);

    expect(recurrence.reopened).toBe(true);
    expect(recurrence.created).toBe(false);
    expect(recurrence.alert).toMatchObject({
      state: 'ALARM',
      status: 'open',
      status_updated_by: INFRA_ALERT_RECURRENCE_ACTOR,
      occurrence_count: 2,
    });
    // Same row, not a second one — the alerts list is what needs attention,
    // not one row per breach.
    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(1);
  });

  it('reopens a manually resolved alert too', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;
    setInfraAlertStatus(PROJECT, alertId, 'resolved', 'user-1', NOW + MINUTE);

    const recurrence = fire(ruleId, 'ALARM', NOW + 2 * MINUTE);

    expect(recurrence.reopened).toBe(true);
    expect(recurrence.alert?.status).toBe('open');
  });

  it('keeps an ignored alert muted through recurrence', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;
    setInfraAlertStatus(PROJECT, alertId, 'ignored', 'user-1', NOW + MINUTE);

    const recurrence = fire(ruleId, 'ALARM', NOW + 2 * MINUTE);

    expect(recurrence.reopened).toBe(false);
    expect(recurrence.alert).toMatchObject({
      status: 'ignored',
      status_updated_by: 'user-1',
      occurrence_count: 2,
    });
  });

  it('keeps an ignored alert muted through a full recover/re-breach round trip', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;
    setInfraAlertStatus(PROJECT, alertId, 'ignored', 'user-1', NOW + MINUTE);

    // Recovery must not auto-resolve an ignored alert: 'resolved' is reopenable
    // by recurrence, so a mute that decayed to resolved would un-mute itself on
    // the next breach — the exact behaviour ignoring exists to prevent.
    const recovered = fire(ruleId, 'OK', NOW + 2 * MINUTE);
    expect(recovered.autoResolved).toBe(false);
    expect(recovered.alert?.status).toBe('ignored');

    const rebreached = fire(ruleId, 'ALARM', NOW + 3 * MINUTE);
    expect(rebreached.reopened).toBe(false);
    expect(rebreached.alert?.status).toBe('ignored');
  });

  it('records the state change but not the status when an ignored alert flips state', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;
    setInfraAlertStatus(PROJECT, alertId, 'ignored', 'user-1', NOW + MINUTE);
    fire(ruleId, 'OK', NOW + 2 * MINUTE);

    const history = listInfraAlertTransitions(alertId);
    expect(history[0]).toMatchObject({
      from_state: 'ALARM',
      to_state: 'OK',
      from_status: 'ignored',
      to_status: 'ignored',
    });
  });

  it('keeps the true min/max window when observations arrive out of order', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    fire(ruleId, 'ALARM', NOW + 10 * MINUTE);

    const late = fire(ruleId, 'ALARM', NOW - 5 * MINUTE, { nowMs: NOW + 11 * MINUTE });

    expect(late.alert).toMatchObject({
      first_seen: NOW - 5 * MINUTE,
      last_seen: NOW + 10 * MINUTE,
      occurrence_count: 3,
    });
  });

  it('does not let a stale evaluation rewrite a newer verdict', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW + 10 * MINUTE, { value: 99 });

    // A tick reading an older window lands after the newer one. Its verdict is
    // evidence about a window that already passed, not a claim about now.
    const stale = fire(ruleId, 'OK', NOW, { nowMs: NOW + 11 * MINUTE });

    expect(stale.stale).toBe(true);
    expect(stale.autoResolved).toBe(false);
    expect(stale.stateChanged).toBe(false);
    expect(stale.alert).toMatchObject({
      state: 'ALARM',
      status: 'open',
      state_updated_at: NOW + 10 * MINUTE,
      last_value: 99,
    });
    expect(listInfraAlertTransitions(stale.alert!.id)).toHaveLength(1);
  });

  it('folds a stale ALARM into the aggregates without reopening a resolved alert', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    fire(ruleId, 'OK', NOW + 10 * MINUTE);

    const stale = fire(ruleId, 'ALARM', NOW + 5 * MINUTE, { nowMs: NOW + 11 * MINUTE });

    expect(stale.stale).toBe(true);
    expect(stale.reopened).toBe(false);
    expect(stale.alert).toMatchObject({
      status: 'resolved',
      state: 'OK',
      last_seen: NOW + 5 * MINUTE,
      occurrence_count: 2,
    });
  });

  it('refuses to touch an alert belonging to another project', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;

    // (rule_id, resource_key) is globally unique, so an observation naming the
    // wrong project resolves to another tenant's row. It must not be read,
    // updated, or returned.
    expect(() =>
      recordInfraAlertEvaluation({
        projectId: 'other-project',
        ruleId,
        resourceKey: RESOURCE,
        evaluation: evaluation('OK'),
        observedAtMs: NOW + MINUTE,
        nowMs: NOW + MINUTE,
      }),
    ).toThrow(InfraAlertProjectMismatchError);

    // Untouched: still ALARM/open, still one occurrence, no extra history.
    expect(getInfraAlert(PROJECT, alertId)).toMatchObject({
      state: 'ALARM',
      status: 'open',
      occurrence_count: 1,
    });
    expect(listInfraAlertTransitions(alertId)).toHaveLength(1);
  });

  it('refuses to open an alert against another project’s rule', () => {
    // No alert row exists yet, so the existing-row guard has nothing to compare
    // against and the FK only enforces that the rule exists. Left unchecked
    // this inserts an alert into PROJECT referencing another project's rule —
    // and every later evaluation then passes, because the bad row vouches for
    // itself.
    const foreignRuleId = createInfraAlertRule('other-project', ruleInput(), NOW).id;

    expect(() =>
      recordInfraAlertEvaluation({
        projectId: PROJECT,
        ruleId: foreignRuleId,
        resourceKey: RESOURCE,
        evaluation: evaluation('ALARM'),
        observedAtMs: NOW,
        nowMs: NOW,
      }),
    ).toThrow(InfraAlertProjectMismatchError);

    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(0);
    expect(listInfraAlerts({ projectId: 'other-project' }).alerts).toHaveLength(0);
  });

  it('refuses to open an alert against a rule that does not exist', () => {
    expect(() =>
      recordInfraAlertEvaluation({
        projectId: PROJECT,
        ruleId: 'no-such-rule',
        resourceKey: RESOURCE,
        evaluation: evaluation('ALARM'),
        observedAtMs: NOW,
        nowMs: NOW,
      }),
    ).toThrow(InfraAlertProjectMismatchError);
  });

  it('refuses to run inside a caller’s open transaction', () => {
    const ruleId = seedRule();
    const db = getInfraDb();

    // A nested transaction becomes a SAVEPOINT and inherits the outer locking
    // mode, so the IMMEDIATE guarantee would silently evaporate. Fail loudly
    // instead of documenting a promise that does not hold.
    expect(() =>
      db.transaction(() => {
        fire(ruleId, 'ALARM', NOW);
      })(),
    ).toThrow(InfraAlertNestedTransactionError);

    expect(db.inTransaction).toBe(false);
    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(0);
  });

  it('rolls the whole evaluation back when the transition append fails', () => {
    const ruleId = seedRule();
    fire(ruleId, 'ALARM', NOW);
    const alertId = listInfraAlerts({ projectId: PROJECT }).alerts[0].id;

    // Force the last write of the sequence to fail. Without the surrounding
    // transaction the alert row would already carry the recurrence — a status
    // move with no history row explaining it.
    const db = getInfraDb();
    db.exec('DROP TABLE infra_alert_transitions');

    expect(() => fire(ruleId, 'OK', NOW + MINUTE)).toThrow();

    expect(getInfraAlert(PROJECT, alertId)).toMatchObject({
      state: 'ALARM',
      status: 'open',
      occurrence_count: 1,
      state_updated_at: NOW,
    });
  });

  it('keys one alert per (rule, resource)', () => {
    const ruleA = seedRule({ name: 'A' });
    const ruleB = seedRule({ name: 'B' });
    fire(ruleA, 'ALARM', NOW);
    fire(ruleB, 'ALARM', NOW);

    expect(listInfraAlerts({ projectId: PROJECT }).alerts).toHaveLength(2);
    expect(listInfraAlerts({ projectId: PROJECT, ruleId: ruleA }).alerts).toHaveLength(1);
  });
});

describe('operator status changes', () => {
  it('records a transition with the acting user as actor', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;

    const updated = setInfraAlertStatus(PROJECT, alertId, 'resolved', 'user-7', NOW + MINUTE);

    expect(updated).toMatchObject({ status: 'resolved', status_updated_by: 'user-7' });
    expect(listInfraAlertTransitions(alertId)[0]).toMatchObject({
      from_status: 'open',
      to_status: 'resolved',
      from_state: 'ALARM',
      to_state: 'ALARM',
      actor: 'user-7',
    });
  });

  it('is a no-op when the status already matches', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;

    setInfraAlertStatus(PROJECT, alertId, 'open', 'user-7', NOW + MINUTE);

    expect(listInfraAlertTransitions(alertId)).toHaveLength(1);
    expect(getInfraAlert(PROJECT, alertId)?.status_updated_by).toBeNull();
  });

  it('refuses to run inside a caller’s open transaction', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;
    const db = getInfraDb();

    // Same rail as recordInfraAlertEvaluation: a SAVEPOINT inherits the outer
    // locking mode, so the IMMEDIATE guarantee this read-decide-write depends
    // on would be void exactly when a concurrent writer exists to need it.
    expect(() =>
      db.transaction(() => {
        setInfraAlertStatus(PROJECT, alertId, 'resolved', 'user-1', NOW + MINUTE);
      })(),
    ).toThrow(InfraAlertNestedTransactionError);

    expect(db.inTransaction).toBe(false);
    expect(getInfraAlert(PROJECT, alertId)?.status).toBe('open');
  });

  it('cannot be reached with another project id', () => {
    const ruleId = seedRule();
    const alertId = fire(ruleId, 'ALARM', NOW).alert!.id;

    expect(setInfraAlertStatus('other-project', alertId, 'ignored', 'user-7', NOW)).toBeNull();
    expect(getInfraAlert('other-project', alertId)).toBeNull();
  });
});

describe('transition history bounds', () => {
  it('trims to the retained window instead of growing with a flapping resource', () => {
    const ruleId = seedRule();
    const flaps = INFRA_ALERT_TRANSITION_HISTORY_LIMIT + 20;
    for (let i = 0; i < flaps; i++) {
      fire(ruleId, i % 2 === 0 ? 'ALARM' : 'OK', NOW + i * MINUTE);
    }
    const alertId = listInfraAlerts({ projectId: PROJECT }).alerts[0].id;

    const rows = getInfraDb()
      .prepare('SELECT COUNT(*) AS n FROM infra_alert_transitions WHERE alert_id = ?')
      .get(alertId) as { n: number };
    expect(rows.n).toBe(INFRA_ALERT_TRANSITION_HISTORY_LIMIT);

    // The aggregate on the alert row is the durable record, and it counts every
    // breach — including the ones whose transition rows were trimmed away.
    const alert = getInfraAlert(PROJECT, alertId)!;
    expect(alert.occurrence_count).toBe(Math.ceil(flaps / 2));
    expect(alert.first_seen).toBe(NOW);

    // Newest kept, oldest dropped.
    const history = listInfraAlertTransitions(alertId);
    expect(history[0].at_ms).toBe(NOW + (flaps - 1) * MINUTE);
    expect(Math.min(...history.map((h) => h.at_ms))).toBeGreaterThan(NOW);
  });
});

describe('alert listing', () => {
  function seedAlerts(count: number): string {
    const ruleId = seedRule();
    for (let i = 0; i < count; i++) {
      recordInfraAlertEvaluation({
        projectId: PROJECT,
        ruleId,
        resourceKey: `${RESOURCE}-${i}`,
        evaluation: evaluation('ALARM'),
        observedAtMs: NOW + i * MINUTE,
        nowMs: NOW + i * MINUTE,
      });
    }
    return ruleId;
  }

  it('pages newest-first with a keyset cursor', () => {
    seedAlerts(5);

    const first = listInfraAlerts({ projectId: PROJECT, limit: 2 });
    expect(first.alerts).toHaveLength(2);
    expect(first.alerts[0].last_seen).toBe(NOW + 4 * MINUTE);
    expect(first.nextCursor).not.toBeNull();

    const second = listInfraAlerts({ projectId: PROJECT, limit: 2, cursor: first.nextCursor! });
    expect(second.alerts.map((a) => a.last_seen)).toEqual([NOW + 2 * MINUTE, NOW + MINUTE]);

    const last = listInfraAlerts({ projectId: PROJECT, limit: 2, cursor: second.nextCursor! });
    expect(last.alerts).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
  });

  it('reads a malformed cursor as the first page rather than throwing', () => {
    seedAlerts(3);
    expect(listInfraAlerts({ projectId: PROJECT, cursor: 'not-a-cursor' }).alerts).toHaveLength(3);
  });

  it('filters by lifecycle status and alarm state', () => {
    const ruleId = seedAlerts(3);
    const alerts = listInfraAlerts({ projectId: PROJECT }).alerts;
    setInfraAlertStatus(PROJECT, alerts[0].id, 'ignored', 'user-1', NOW + 10 * MINUTE);
    recordInfraAlertEvaluation({
      projectId: PROJECT,
      ruleId,
      resourceKey: alerts[1].resource_key,
      evaluation: evaluation('OK'),
      observedAtMs: NOW + 20 * MINUTE,
      nowMs: NOW + 20 * MINUTE,
    });

    expect(listInfraAlerts({ projectId: PROJECT, status: 'ignored' }).alerts).toHaveLength(1);
    expect(listInfraAlerts({ projectId: PROJECT, status: 'open' }).alerts).toHaveLength(1);
    expect(listInfraAlerts({ projectId: PROJECT, state: 'OK' }).alerts).toHaveLength(1);
    expect(listInfraAlerts({ projectId: PROJECT, state: 'ALARM' }).alerts).toHaveLength(2);
  });

  it('never returns another project’s alerts', () => {
    seedAlerts(3);
    expect(listInfraAlerts({ projectId: 'other-project' }).alerts).toHaveLength(0);
  });

  it('attaches transitions only on the detail serialization', () => {
    const ruleId = seedRule();
    const alert = fire(ruleId, 'ALARM', NOW).alert!;

    expect(serializeInfraAlert(alert).transitions).toBeUndefined();
    expect(serializeInfraAlert(alert, listInfraAlertTransitions(alert.id)).transitions).toEqual([
      {
        fromState: 'OK',
        toState: 'ALARM',
        fromStatus: 'open',
        toStatus: 'open',
        reason: 'datapoints_breached',
        actor: 'system:evaluator',
        atMs: NOW,
      },
    ]);
  });
});
