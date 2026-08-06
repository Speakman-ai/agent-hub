/**
 * The evaluation sweep, against a seeded `infra.db`.
 *
 * The behaviours pinned here are the ones the design turns on and a refactor
 * would plausibly break: a notification fires once on the transition and not
 * again while the alarm sits in ALARM, recovery emits its own OK transition,
 * the range is bucketed on completed periods only, a rule the evaluator refuses
 * costs that rule its tick and nothing else, and a broadcast carries no AWS
 * account id.
 *
 * No AWS client is ever constructed — the sweep reads SQLite and nothing else.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  infraDimensionsHash,
  insertInfraMetricPoints,
  type InfraMetricPointRow,
} from './infra-metric-store.js';
import {
  createInfraAlertRule,
  getInfraAlertForResource,
  listEnabledInfraAlertRules,
  listInfraAlertTransitions,
  type InfraAlertRuleInput,
  type InfraAlertRuleRow,
} from './alert-store.js';
import { INFRA_ALERT_RECOVERY_ACTOR, INFRA_ALERT_EVALUATOR_ACTOR } from './infra-schema.js';
import {
  runInfraAlertEvaluation,
  bucketPointsIntoSlots,
  evaluationRangeLength,
  listRuleResources,
  readEvaluationRange,
  resolveSeriesDimensionsHash,
  AmbiguousMetricSeriesError,
  EVALUATION_RANGE_PADDING,
} from './alert-runner.js';

let dir: string;

const PROJECT = 'proj-runner';
const ACCOUNT = '123456789012';
const REGION = 'us-east-2';
const MINUTE = 60_000;
/** A minute boundary, so period alignment in the tests is exact. */
const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);

const RESOURCE_KEY = infraResourceKey({
  projectId: PROJECT,
  accountId: ACCOUNT,
  region: REGION,
  service: 'ec2',
  resourceId: 'i-0abc',
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-alert-runner-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seedResource(overrides: Partial<Record<string, unknown>> = {}): string {
  const row = {
    resource_key: RESOURCE_KEY,
    project_id: PROJECT,
    account_id: ACCOUNT,
    region: REGION,
    service: 'ec2',
    resource_id: 'i-0abc',
    name: 'web-1',
    tags_json: JSON.stringify([{ Key: 'env', Value: 'prod' }]),
    environment: null,
    state: 'running',
    first_seen: NOW - 10 * MINUTE,
    last_seen: NOW,
    ...overrides,
  };
  getInfraDb()
    .prepare(
      `INSERT INTO infra_resources
         (resource_key, project_id, account_id, region, service, resource_id, name,
          tags_json, environment, state, first_seen, last_seen)
       VALUES (@resource_key, @project_id, @account_id, @region, @service, @resource_id,
               @name, @tags_json, @environment, @state, @first_seen, @last_seen)`,
    )
    .run(row);
  return row.resource_key as string;
}

function seedRule(overrides: Partial<InfraAlertRuleInput> = {}): InfraAlertRuleRow {
  return createInfraAlertRule(
    PROJECT,
    {
      name: 'EC2 CPU high',
      service: 'ec2',
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      stat: 'Average',
      periodS: 60,
      threshold: 90,
      comparisonOperator: 'GreaterThanThreshold',
      evaluationPeriods: 2,
      ...overrides,
    },
    NOW - MINUTE,
  );
}

/**
 * Write `values` into the periods immediately before `endMs`, newest last.
 * `endMs` defaults to the last completed minute boundary before {@link NOW}.
 */
function seedSeries(
  values: number[],
  endMs = NOW,
  resourceKey = RESOURCE_KEY,
  dimensions: Record<string, string> = { InstanceId: 'i-0abc' },
): void {
  insertInfraMetricPoints(
    values.map((value, i) => ({
      projectId: PROJECT,
      resourceKey,
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      dimensions,
      stat: 'Average',
      periodSeconds: 60,
      tsMs: endMs - (values.length - i) * MINUTE,
      value,
    })),
  );
}

/** The resource the rules below evaluate against, as the sweep passes it. */
const RESOURCE = { resource_key: RESOURCE_KEY, resource_id: 'i-0abc' };

describe('evaluationRangeLength', () => {
  it("reproduces AWS's published worked example (N=3 → range 5)", () => {
    expect(evaluationRangeLength(3, EVALUATION_RANGE_PADDING)).toBe(5);
  });

  it('never returns fewer than one slot', () => {
    expect(evaluationRangeLength(0, 0)).toBe(1);
    expect(evaluationRangeLength(-4, -4)).toBe(1);
  });
});

describe('bucketPointsIntoSlots', () => {
  const point = (tsMs: number, value: number): InfraMetricPointRow => ({
    id: 1,
    projectId: PROJECT,
    resourceKey: RESOURCE_KEY,
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    dimensionsHash: 'h',
    dimensionsJson: null,
    stat: 'Average',
    periodSeconds: 60,
    tsMs,
    value,
  });

  it('places each point in the period it starts, oldest first', () => {
    const range = bucketPointsIntoSlots(
      [point(NOW - 3 * MINUTE, 10), point(NOW - MINUTE, 30)],
      NOW,
      MINUTE,
      3,
    );
    expect(range.datapoints).toEqual([10, null, 30]);
    expect(range.rangeStartMs).toBe(NOW - 3 * MINUTE);
    expect(range.rangeEndMs).toBe(NOW);
  });

  it('reports the newest real datapoint as the observation clock', () => {
    const range = bucketPointsIntoSlots([point(NOW - 2 * MINUTE, 7)], NOW, MINUTE, 3);
    expect(range.latestValue).toBe(7);
    expect(range.observedAtMs).toBe(NOW - 2 * MINUTE);
  });

  it('falls back to the range end when nothing reported, so a dark series stays orderable', () => {
    const range = bucketPointsIntoSlots([], NOW, MINUTE, 3);
    expect(range.datapoints).toEqual([null, null, null]);
    expect(range.latestValue).toBeNull();
    expect(range.observedAtMs).toBe(NOW);
  });

  it('drops points outside the range and non-finite values', () => {
    const range = bucketPointsIntoSlots(
      [point(NOW - 9 * MINUTE, 1), point(NOW, 2), point(NOW - MINUTE, Number.NaN)],
      NOW,
      MINUTE,
      3,
    );
    expect(range.datapoints).toEqual([null, null, null]);
  });
});

describe('readEvaluationRange', () => {
  it('excludes the period in progress, whose aggregate is incomplete', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    // The in-progress period starts at NOW; a point stamped there must not be
    // evaluated against a threshold tuned for a whole period.
    seedSeries([10, 20], NOW + MINUTE);

    const range = readEvaluationRange(rule, RESOURCE, NOW + 30_000, EVALUATION_RANGE_PADDING);
    expect(range.rangeEndMs).toBe(NOW);
    // The newest evaluated slot is the last period that fully elapsed, holding
    // 10; the 20 stamped at NOW belongs to the period still filling.
    expect(range.datapoints.at(-1)).toBe(10);
    expect(range.datapoints).not.toContain(20);
    expect(range.observedAtMs).toBe(NOW - MINUTE);
  });

  it('reads N + padding slots', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 3 });
    const range = readEvaluationRange(rule, RESOURCE, NOW, EVALUATION_RANGE_PADDING);
    expect(range.datapoints).toHaveLength(5);
  });

  it('never truncates the far end of the range when other dimension sets are present', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 3 });
    // 5 slots x 5 series = 25 rows in the window. The union read this replaced
    // was bounded by a row limit of slotCount * 4 = 20 and ordered newest-first,
    // so the five oldest rows fell off the far end of the range — and the ones
    // that survived were collapsed into shared slots by row order anyway.
    seedSeries([1, 2, 3, 4, 5], NOW);
    for (const az of ['a', 'b', 'c', 'd']) {
      seedSeries([90, 91, 92, 93, 94], NOW, RESOURCE_KEY, {
        InstanceId: 'i-0abc',
        AvailabilityZone: `us-east-2${az}`,
      });
    }

    const range = readEvaluationRange(rule, RESOURCE, NOW, EVALUATION_RANGE_PADDING);
    expect(range.datapoints).toEqual([1, 2, 3, 4, 5]);
    expect(range.latestValue).toBe(5);
  });
});

describe('resolveSeriesDimensionsHash', () => {
  const window = (): [number, number] => [NOW - 10 * MINUTE, NOW];

  it('returns null for a window with no points, so a dark series still evaluates', () => {
    seedResource();
    expect(resolveSeriesDimensionsHash(seedRule(), RESOURCE, ...window())).toBeNull();
  });

  it('uses the only dimension set present without consulting the pack', () => {
    seedResource();
    // Deliberately not the pack's `{InstanceId}` set: one unambiguous series is
    // the series, and preferring the pack here would make a pack whose
    // dimension name changed go silently dark against data we did collect.
    seedSeries([1, 2, 3], NOW, RESOURCE_KEY, { LoadBalancer: 'app/web/abc' });
    expect(resolveSeriesDimensionsHash(seedRule(), RESOURCE, ...window())).toBe(
      infraDimensionsHash({ LoadBalancer: 'app/web/abc' }),
    );
  });

  it('prefers the series its service metric pack collects when several exist', () => {
    seedResource();
    seedSeries([1, 2, 3]);
    seedSeries([90, 91, 92], NOW, RESOURCE_KEY, {
      InstanceId: 'i-0abc',
      AvailabilityZone: 'us-east-2a',
    });
    expect(resolveSeriesDimensionsHash(seedRule(), RESOURCE, ...window())).toBe(
      infraDimensionsHash({ InstanceId: 'i-0abc' }),
    );
  });

  it('refuses to guess when several series exist and none is the pack’s', () => {
    seedResource();
    seedSeries([1, 2, 3], NOW, RESOURCE_KEY, { AvailabilityZone: 'us-east-2a' });
    seedSeries([90, 91, 92], NOW, RESOURCE_KEY, { AvailabilityZone: 'us-east-2b' });
    expect(() => resolveSeriesDimensionsHash(seedRule(), RESOURCE, ...window())).toThrow(
      AmbiguousMetricSeriesError,
    );
  });

  it('does not confuse another period tier for a second dimension set', () => {
    seedResource();
    seedSeries([1, 2, 3]);
    insertInfraMetricPoints([
      {
        projectId: PROJECT,
        resourceKey: RESOURCE_KEY,
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensions: { InstanceId: 'i-0abc' },
        stat: 'Average',
        periodSeconds: 300,
        tsMs: NOW - 5 * MINUTE,
        value: 99,
      },
    ]);
    expect(resolveSeriesDimensionsHash(seedRule(), RESOURCE, ...window())).toBe(
      infraDimensionsHash({ InstanceId: 'i-0abc' }),
    );
  });
});

describe('listRuleResources', () => {
  it('expands a service selector into every matching resource', () => {
    seedResource();
    seedResource({
      resource_key: infraResourceKey({
        projectId: PROJECT,
        accountId: ACCOUNT,
        region: REGION,
        service: 'ec2',
        resourceId: 'i-0def',
      }),
      resource_id: 'i-0def',
      tags_json: JSON.stringify([{ Key: 'env', Value: 'staging' }]),
    });
    const rule = seedRule();
    expect(listRuleResources(rule, NOW).map((r) => r.resource_id)).toEqual(['i-0abc', 'i-0def']);
  });

  it('applies the tag predicate', () => {
    seedResource();
    seedResource({
      resource_key: infraResourceKey({
        projectId: PROJECT,
        accountId: ACCOUNT,
        region: REGION,
        service: 'ec2',
        resourceId: 'i-0def',
      }),
      resource_id: 'i-0def',
      tags_json: JSON.stringify([{ Key: 'env', Value: 'staging' }]),
    });
    const rule = seedRule({ tagFilter: { env: ['prod'] } });
    expect(listRuleResources(rule, NOW).map((r) => r.resource_id)).toEqual(['i-0abc']);
  });

  it('excludes terminated and long-unseen resources, matching the collector', () => {
    seedResource({ state: 'terminated' });
    seedResource({
      resource_key: infraResourceKey({
        projectId: PROJECT,
        accountId: ACCOUNT,
        region: REGION,
        service: 'ec2',
        resourceId: 'i-0old',
      }),
      resource_id: 'i-0old',
      last_seen: NOW - 48 * 60 * MINUTE,
    });
    expect(listRuleResources(seedRule(), NOW)).toEqual([]);
  });

  it('evaluates a pinned resource_key even with no inventory row behind it', () => {
    const rule = seedRule({ resourceKey: RESOURCE_KEY });
    const resources = listRuleResources(rule, NOW);
    expect(resources).toHaveLength(1);
    expect(resources[0].resource_key).toBe(RESOURCE_KEY);
    // Decoded from the key, not the key itself: the key embeds the AWS account
    // id, and it is the resource id that reaches a broadcast and the dimension
    // set the series is read on.
    expect(resources[0].resource_id).toBe('i-0abc');
  });

  it('refuses a pinned resource_key it did not mint rather than inventing an id', () => {
    const rule = seedRule({ resourceKey: 'not-a-real-key' });
    expect(() => listRuleResources(rule, NOW)).toThrow(/unparseable resource_key/);
  });

  it('never crosses a project boundary', () => {
    seedResource({ project_id: 'other-project' });
    expect(listRuleResources(seedRule(), NOW)).toEqual([]);
  });
});

describe('runInfraAlertEvaluation', () => {
  it('is a no-op when infra.db was never opened', () => {
    closeInfraDb();
    expect(runInfraAlertEvaluation({ nowMs: NOW }).rules).toBe(0);
    initInfraDb(dir);
  });

  it('fires one transition on the breach and does not re-fire while it persists', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);

    const broadcast = vi.fn();
    const first = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(first.evaluations).toBe(1);
    expect(first.transitions).toBe(1);
    expect(first.created).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'infra_alert_transition',
      projectId: PROJECT,
      fromState: 'OK',
      toState: 'ALARM',
      reason: 'datapoints_breached',
    });

    // A minute later the metric is still breaching. CloudWatch's contract is
    // that actions fire on the state change, not on the state.
    seedSeries([99], NOW + MINUTE);
    const second = runInfraAlertEvaluation({ nowMs: NOW + MINUTE, broadcast });
    expect(second.evaluations).toBe(1);
    expect(second.transitions).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);

    const alert = getInfraAlertForResource(rule.id, RESOURCE_KEY);
    expect(alert?.state).toBe('ALARM');
    expect(alert?.occurrence_count).toBe(2);
  });

  it('stays quiet for an hour of sustained ALARM', () => {
    seedResource();
    seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);

    const broadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    for (let i = 1; i <= 60; i += 1) {
      seedSeries([99], NOW + i * MINUTE);
      runInfraAlertEvaluation({ nowMs: NOW + i * MINUTE, broadcast });
    }
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('emits an OK transition on recovery and auto-resolves the alert', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);

    const broadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast });

    // Three healthy minutes: enough real datapoints that the missing-data
    // treatment is not consulted at all.
    seedSeries([5, 5, 5], NOW + 3 * MINUTE);
    const recovery = runInfraAlertEvaluation({ nowMs: NOW + 3 * MINUTE, broadcast });

    expect(recovery.transitions).toBe(1);
    expect(recovery.autoResolved).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(broadcast.mock.calls[1][0]).toMatchObject({
      fromState: 'ALARM',
      toState: 'OK',
      autoResolved: true,
    });

    const alert = getInfraAlertForResource(rule.id, RESOURCE_KEY);
    expect(alert?.state).toBe('OK');
    expect(alert?.status).toBe('resolved');
  });

  it('appends both transitions to the alert history with the system actors', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);
    runInfraAlertEvaluation({ nowMs: NOW });
    seedSeries([5, 5, 5], NOW + 3 * MINUTE);
    runInfraAlertEvaluation({ nowMs: NOW + 3 * MINUTE });

    const alert = getInfraAlertForResource(rule.id, RESOURCE_KEY);
    const history = listInfraAlertTransitions(alert!.id);
    expect(history.map((t) => [t.from_state, t.to_state, t.actor])).toEqual([
      ['ALARM', 'OK', INFRA_ALERT_RECOVERY_ACTOR],
      ['OK', 'ALARM', INFRA_ALERT_EVALUATOR_ACTOR],
    ]);
  });

  it('opens no alert for a healthy resource', () => {
    seedResource();
    const rule = seedRule();
    seedSeries([1, 2, 3]);

    const broadcast = vi.fn();
    const result = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(result.evaluations).toBe(1);
    expect(result.transitions).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(getInfraAlertForResource(rule.id, RESOURCE_KEY)).toBeNull();
  });

  it('opens no alert for a resource that has never reported', () => {
    seedResource();
    const rule = seedRule();
    const broadcast = vi.fn();

    const result = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(result.evaluations).toBe(1);
    expect(result.transitions).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(getInfraAlertForResource(rule.id, RESOURCE_KEY)).toBeNull();
  });

  it('skips disabled rules', () => {
    seedResource();
    seedRule({ enabled: false });
    seedSeries([95, 97, 99]);
    const result = runInfraAlertEvaluation({ nowMs: NOW });
    expect(result.rules).toBe(0);
    expect(result.evaluations).toBe(0);
  });

  it('isolates a rule whose tag filter is malformed', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedResource();
    const broken = seedRule({ name: 'broken' });
    getInfraDb()
      .prepare('UPDATE infra_alert_rules SET tag_filter_json = ? WHERE id = ?')
      .run('{not json', broken.id);
    const healthy = seedRule({ name: 'healthy', threshold: 10 });
    seedSeries([95, 97, 99]);

    const result = runInfraAlertEvaluation({ nowMs: NOW });
    expect(result.ruleErrors).toBe(1);
    expect(result.evaluations).toBe(1);
    expect(getInfraAlertForResource(healthy.id, RESOURCE_KEY)?.state).toBe('ALARM');
  });

  it('isolates a rule the evaluator refuses without losing the rest of the sweep', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedResource();
    const broken = seedRule({ name: 'broken' });
    // M > N can never reach ALARM, so the evaluator throws rather than repairing
    // it into an alarm that looks armed and is not. Written straight to SQLite
    // because createInfraAlertRule refuses the same shape.
    getInfraDb()
      .prepare('UPDATE infra_alert_rules SET datapoints_to_alarm = 9 WHERE id = ?')
      .run(broken.id);
    const healthy = seedRule({ name: 'healthy', threshold: 10 });
    seedSeries([95, 97, 99]);

    const result = runInfraAlertEvaluation({ nowMs: NOW });
    expect(result.resourceErrors).toBe(1);
    expect(result.rules).toBe(2);
    expect(getInfraAlertForResource(healthy.id, RESOURCE_KEY)?.state).toBe('ALARM');
    expect(getInfraAlertForResource(broken.id, RESOURCE_KEY)).toBeNull();
  });

  it('evaluates the pack series and ignores a second dimension set on the same metric', () => {
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    // The pack series is healthy; the per-AZ series is breaching. Reading the
    // union would have alarmed on numbers the rule never named.
    seedSeries([1, 2, 3]);
    seedSeries([95, 97, 99], NOW, RESOURCE_KEY, {
      InstanceId: 'i-0abc',
      AvailabilityZone: 'us-east-2a',
    });

    const broadcast = vi.fn();
    const result = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(result.evaluations).toBe(1);
    expect(result.transitions).toBe(0);
    expect(result.ambiguousSeries).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(getInfraAlertForResource(rule.id, RESOURCE_KEY)).toBeNull();
  });

  it('isolates an ambiguous series instead of alarming on an arbitrary one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedResource();
    const ambiguous = seedRule({ name: 'ambiguous', evaluationPeriods: 2 });
    seedSeries([95, 97, 99], NOW, RESOURCE_KEY, { AvailabilityZone: 'us-east-2a' });
    seedSeries([1, 2, 3], NOW, RESOURCE_KEY, { AvailabilityZone: 'us-east-2b' });

    const broadcast = vi.fn();
    const result = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(result.resourceErrors).toBe(1);
    expect(result.ambiguousSeries).toBe(1);
    expect(result.transitions).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(getInfraAlertForResource(ambiguous.id, RESOURCE_KEY)).toBeNull();
  });

  it('keeps the account id out of a broadcast for a pinned rule with no inventory row', () => {
    // The regression: the resource id used to fall back to the whole resource
    // key, which encodes the AWS account id, straight into a payload that fans
    // out to every connected client.
    seedRule({ evaluationPeriods: 2, resourceKey: RESOURCE_KEY });
    seedSeries([95, 97, 99]);

    const broadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = JSON.stringify(broadcast.mock.calls[0][0]);
    expect(payload).not.toContain(ACCOUNT);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ resourceId: 'i-0abc', toState: 'ALARM' });
  });

  it('records the transition even when the broadcast throws', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    seedResource();
    const rule = seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);

    const result = runInfraAlertEvaluation({
      nowMs: NOW,
      broadcast: () => {
        throw new Error('no websocket server');
      },
    });
    expect(result.transitions).toBe(1);
    expect(result.broadcastErrors).toBe(1);
    expect(getInfraAlertForResource(rule.id, RESOURCE_KEY)?.state).toBe('ALARM');

    const recoveredBroadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast: recoveredBroadcast });
    expect(recoveredBroadcast).toHaveBeenCalledTimes(1);
    expect(recoveredBroadcast.mock.calls[0][0]).toMatchObject({
      type: 'infra_alert_transition',
      toState: 'ALARM',
      resourceId: 'i-0abc',
    });
  });

  it('keeps a transition pending when no broadcast transport is configured', () => {
    seedResource();
    seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);

    runInfraAlertEvaluation({ nowMs: NOW });

    const recoveredBroadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast: recoveredBroadcast });
    expect(recoveredBroadcast).toHaveBeenCalledTimes(1);
  });

  it('keeps the AWS account id out of the broadcast (INFRA-NOTIFY)', () => {
    seedResource();
    seedRule({ evaluationPeriods: 2, accountId: ACCOUNT, region: REGION });
    seedSeries([95, 97, 99]);

    const broadcast = vi.fn();
    runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    const payload = JSON.stringify(broadcast.mock.calls[0][0]);
    expect(payload).not.toContain(ACCOUNT);
    expect(payload).not.toContain(RESOURCE_KEY);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ resourceId: 'i-0abc', severity: 'warning' });
  });

  it('evaluates every resource a rule expands to', () => {
    seedResource();
    const second = infraResourceKey({
      projectId: PROJECT,
      accountId: ACCOUNT,
      region: REGION,
      service: 'ec2',
      resourceId: 'i-0def',
    });
    seedResource({ resource_key: second, resource_id: 'i-0def' });
    seedRule({ evaluationPeriods: 2 });
    seedSeries([95, 97, 99]);
    seedSeries([1, 1, 1], NOW, second);

    const broadcast = vi.fn();
    const result = runInfraAlertEvaluation({ nowMs: NOW, broadcast });
    expect(result.evaluations).toBe(2);
    expect(result.transitions).toBe(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({ resourceId: 'i-0abc' });
  });

  it('scopes a sweep to one project when asked', () => {
    seedResource();
    seedRule();
    const other = createInfraAlertRule(
      'other-project',
      {
        name: 'other',
        service: 'ec2',
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        stat: 'Average',
        periodS: 60,
        threshold: 90,
        comparisonOperator: 'GreaterThanThreshold',
        evaluationPeriods: 2,
      },
      NOW,
    );
    expect(listEnabledInfraAlertRules().map((r) => r.id)).toContain(other.id);
    expect(runInfraAlertEvaluation({ nowMs: NOW, projectId: PROJECT }).rules).toBe(1);
  });

  it('counts a rule whose selector matches nothing without evaluating', () => {
    seedRule({ service: 'rds' });
    const result = runInfraAlertEvaluation({ nowMs: NOW });
    expect(result.rules).toBe(1);
    expect(result.rulesWithoutResources).toBe(1);
    expect(result.evaluations).toBe(0);
  });
});
