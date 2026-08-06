/**
 * Cost store: month-to-date spend out of the run audit trail, the ceiling row's
 * resolved-with-defaults semantics, and the transition-only degradation record
 * that gates the in-app notice.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import {
  startInfraCollectRun,
  finishInfraCollectRun,
  recordInfraCollectRunProgress,
} from './infra-metric-store.js';
import {
  getInfraCostConfig,
  setInfraCostCeiling,
  recordCostDegradation,
  getInfraSpendToDate,
  resolveProjectDegradation,
  listInfraCollectRuns,
  listScopeResourceCounts,
  MAX_COLLECT_RUNS_PER_QUERY,
} from './infra-cost-store.js';

let dir: string;

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const MONTH_START = Date.UTC(2026, 7, 1);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-cost-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

/** Write a finished collect run with a known cost. */
function run(
  projectId: string,
  startedAt: number,
  costUsd: number,
  over: { metricsRequested?: number; status?: 'ok' | 'partial' | 'failed'; region?: string } = {},
): string {
  const id = `run-${projectId}-${startedAt}-${Math.round(costUsd * 1e6)}`;
  startInfraCollectRun({
    id,
    projectId,
    accountId: '111122223333',
    region: over.region ?? 'us-east-1',
    startedAt,
  });
  // Counters are accounted as the spend is incurred, so the helper mirrors the
  // collector: progress first, then the terminal close.
  recordInfraCollectRunProgress(id, {
    queriesIssued: 2,
    metricsRequested: over.metricsRequested ?? 1000,
    datapointsReturned: 40,
    pointsWritten: 40,
    throttles: 1,
    errors: 0,
    estimatedCostUsd: costUsd,
  });
  finishInfraCollectRun(id, {
    finishedAt: startedAt + 1_500,
    status: over.status ?? 'ok',
  });
  return id;
}

describe('getInfraSpendToDate', () => {
  it('sums only this UTC month', () => {
    run('proj-a', MONTH_START + 1000, 0.5);
    run('proj-a', NOW - 1000, 0.25);
    // Last month — must not count, or the ceiling never resets.
    run('proj-a', Date.UTC(2026, 6, 20), 99);

    const spend = getInfraSpendToDate('proj-a', NOW);
    expect(spend.monthStartMs).toBe(MONTH_START);
    expect(spend.monthToDateUsd).toBeCloseTo(0.75, 10);
    expect(spend.runs).toBe(2);
    expect(spend.metricsRequested).toBe(2000);
    expect(spend.throttles).toBe(2);
  });

  it('excludes a run stamped into next month, and counts it exactly once', () => {
    // Regression: the window had no upper bound, so a row that forward clock
    // skew stamped into September was summed into August's month-to-date *and*
    // again into September's. Double-counted spend can pause collection
    // against budget that was never actually spent.
    run('proj-a', NOW - 1000, 5);
    const nextMonth = Date.UTC(2026, 8, 2);
    run('proj-a', nextMonth, 40);

    const august = getInfraSpendToDate('proj-a', NOW);
    expect(august.monthToDateUsd).toBeCloseTo(5, 10);
    expect(august.runs).toBe(1);
    // Not silently dropped — the operator can see the clock is wrong.
    expect(august.futureDatedRuns).toBe(1);

    // And when that month actually arrives it is counted, once.
    const september = getInfraSpendToDate('proj-a', Date.UTC(2026, 8, 15));
    expect(september.monthToDateUsd).toBeCloseTo(40, 10);
    expect(september.runs).toBe(1);
    expect(september.futureDatedRuns).toBe(0);
  });

  it('still counts a tick a slightly fast clock stamped in the future', () => {
    // Why the bound is the month boundary and not `nowMs`: a run row is written
    // when a tick *starts* and the money is spent during it, so a clock running
    // a couple of seconds fast makes a legitimate in-flight tick briefly
    // future-dated. Excluding it would drop real spend from the ceiling — the
    // under-reporting direction this module refuses everywhere else.
    run('proj-a', NOW + 5_000, 12);
    const spend = getInfraSpendToDate('proj-a', NOW);
    expect(spend.monthToDateUsd).toBeCloseTo(12, 10);
    expect(spend.runs).toBe(1);
    expect(spend.futureDatedRuns).toBe(0);
  });

  it('does not let a next-month row prematurely degrade collection', () => {
    setInfraCostCeiling('proj-a', 10, MONTH_START);
    run('proj-a', Date.UTC(2026, 8, 2), 500);
    // The ceiling must not trip on spend attributed to a month that has not
    // started yet.
    expect(resolveProjectDegradation('proj-a', NOW).level).toBe('normal');
  });

  it('counts future-dated runs per project, not globally', () => {
    run('proj-a', Date.UTC(2026, 8, 2), 1);
    run('proj-b', NOW - 1000, 1);
    expect(getInfraSpendToDate('proj-a', NOW).futureDatedRuns).toBe(1);
    expect(getInfraSpendToDate('proj-b', NOW).futureDatedRuns).toBe(0);
  });

  it('does not leak spend across projects', () => {
    run('proj-a', NOW - 1000, 1);
    run('proj-b', NOW - 1000, 50);
    expect(getInfraSpendToDate('proj-a', NOW).monthToDateUsd).toBeCloseTo(1, 10);
    expect(getInfraSpendToDate('proj-b', NOW).monthToDateUsd).toBeCloseTo(50, 10);
  });

  it('counts a crashed tick that never finished', () => {
    // A run row with no finished_at is a tick that died mid-flight. It still
    // issued billed requests, and a spend audit that skipped them would
    // under-report exactly the runs most likely to have been retried.
    startInfraCollectRun({ id: 'orphan', projectId: 'proj-a', startedAt: NOW - 500 });
    const spend = getInfraSpendToDate('proj-a', NOW);
    expect(spend.runs).toBe(1);
    expect(spend.monthToDateUsd).toBe(0);
  });

  it('is all zeroes for a project that has never collected', () => {
    const spend = getInfraSpendToDate('proj-none', NOW);
    expect(spend).toMatchObject({ monthToDateUsd: 0, runs: 0, metricsRequested: 0 });
    expect(spend.extrapolatedMonthUsd).toBe(0);
  });

  it('extrapolates the month from what has elapsed', () => {
    run('proj-a', MONTH_START + 1000, 7);
    const spend = getInfraSpendToDate('proj-a', NOW);
    // 14.5 days into a 31-day August. Extrapolation uses the *real* length of
    // the month in progress, not the conservative 31-day constant the
    // configuration projection rounds with — these answer different questions.
    expect(spend.extrapolatedMonthUsd).toBeGreaterThan(spend.monthToDateUsd);
    expect(spend.extrapolatedMonthUsd).toBeCloseTo(7 * (31 / 14.5), 1);
  });
});

describe('getInfraCostConfig', () => {
  it('resolves to uncapped defaults with no row, and says so', () => {
    const config = getInfraCostConfig('proj-a');
    expect(config).toEqual({
      projectId: 'proj-a',
      monthlyCeilingUsd: null,
      degradationLevel: 'normal',
      degradedAt: null,
      updatedAt: null,
      configured: false,
    });
  });

  it('reports configured once a ceiling is written', () => {
    setInfraCostCeiling('proj-a', 25, NOW);
    const config = getInfraCostConfig('proj-a');
    expect(config.monthlyCeilingUsd).toBe(25);
    expect(config.configured).toBe(true);
    expect(config.updatedAt).toBe(NOW);
  });

  it('keeps a zero ceiling distinct from no ceiling', () => {
    setInfraCostCeiling('proj-a', 0, NOW);
    expect(getInfraCostConfig('proj-a').monthlyCeilingUsd).toBe(0);
    setInfraCostCeiling('proj-a', null, NOW);
    expect(getInfraCostConfig('proj-a').monthlyCeilingUsd).toBeNull();
    // Still configured — the operator deliberately removed the ceiling.
    expect(getInfraCostConfig('proj-a').configured).toBe(true);
  });
});

describe('setInfraCostCeiling', () => {
  it('does not reset the degradation level', () => {
    // Otherwise re-saving the same ceiling un-pauses the project, and the next
    // tick pauses it again after one more round of billed requests.
    recordCostDegradation('proj-a', 'paused', NOW);
    setInfraCostCeiling('proj-a', 100, NOW + 1000);
    const config = getInfraCostConfig('proj-a');
    expect(config.degradationLevel).toBe('paused');
    expect(config.monthlyCeilingUsd).toBe(100);
  });
});

describe('recordCostDegradation', () => {
  it('reports the first move away from normal as a change', () => {
    const first = recordCostDegradation('proj-a', 'widened', NOW);
    expect(first).toEqual({ changed: true, previous: 'normal' });
    expect(getInfraCostConfig('proj-a').degradedAt).toBe(NOW);
  });

  it('reports no change while the level holds, so the notice fires once', () => {
    recordCostDegradation('proj-a', 'widened', NOW);
    for (let i = 1; i <= 5; i += 1) {
      expect(recordCostDegradation('proj-a', 'widened', NOW + i * 300_000).changed).toBe(false);
    }
    // The timestamp is the transition's, not the latest tick's.
    expect(getInfraCostConfig('proj-a').degradedAt).toBe(NOW);
  });

  it('reports each escalation and the recovery', () => {
    expect(recordCostDegradation('proj-a', 'widened', NOW).changed).toBe(true);
    expect(recordCostDegradation('proj-a', 'paused', NOW + 1000)).toEqual({
      changed: true,
      previous: 'widened',
    });
    expect(recordCostDegradation('proj-a', 'normal', NOW + 2000)).toEqual({
      changed: true,
      previous: 'paused',
    });
    // Back to normal clears the stamp — there is no active degradation to date.
    expect(getInfraCostConfig('proj-a').degradedAt).toBeNull();
  });

  it('leaves an existing ceiling alone', () => {
    setInfraCostCeiling('proj-a', 40, NOW);
    recordCostDegradation('proj-a', 'paused', NOW + 1000);
    expect(getInfraCostConfig('proj-a').monthlyCeilingUsd).toBe(40);
  });
});

describe('resolveProjectDegradation', () => {
  it('is normal for an uncapped project however much it has spent', () => {
    run('proj-a', NOW - 1000, 500);
    expect(resolveProjectDegradation('proj-a', NOW).level).toBe('normal');
  });

  it('widens once spend reaches the ceiling', () => {
    setInfraCostCeiling('proj-a', 10, MONTH_START);
    run('proj-a', NOW - 2000, 6);
    expect(resolveProjectDegradation('proj-a', NOW).level).toBe('normal');
    run('proj-a', NOW - 1000, 5);
    expect(resolveProjectDegradation('proj-a', NOW).level).toBe('widened');
  });

  it('pauses at twice the ceiling', () => {
    setInfraCostCeiling('proj-a', 10, MONTH_START);
    run('proj-a', NOW - 1000, 20);
    const resolved = resolveProjectDegradation('proj-a', NOW);
    expect(resolved.level).toBe('paused');
    expect(resolved.spend.monthToDateUsd).toBeCloseTo(20, 10);
    expect(resolved.config.monthlyCeilingUsd).toBe(10);
  });

  it('recovers to normal when the month rolls over', () => {
    setInfraCostCeiling('proj-a', 10, MONTH_START);
    run('proj-a', NOW - 1000, 50);
    expect(resolveProjectDegradation('proj-a', NOW).level).toBe('paused');
    // Same rows, next month's clock: the spend window has moved past them.
    expect(resolveProjectDegradation('proj-a', Date.UTC(2026, 8, 2)).level).toBe('normal');
  });
});

describe('listInfraCollectRuns', () => {
  it('returns the newest ticks first with their cost', () => {
    run('proj-a', NOW - 3000, 0.1);
    run('proj-a', NOW - 1000, 0.3);
    const rows = listInfraCollectRuns('proj-a');
    expect(rows).toHaveLength(2);
    expect(rows[0].startedAt).toBeGreaterThan(rows[1].startedAt);
    expect(rows[0].estimatedCostUsd).toBeCloseTo(0.3, 10);
    expect(rows[0].durationMs).toBe(1500);
    expect(rows[0].status).toBe('ok');
  });

  it('caps the page rather than returning an archive', () => {
    for (let i = 0; i < 5; i += 1) run('proj-a', NOW - i * 1000, 0.01);
    expect(listInfraCollectRuns('proj-a', 2)).toHaveLength(2);
    expect(listInfraCollectRuns('proj-a', 10_000).length).toBeLessThanOrEqual(
      MAX_COLLECT_RUNS_PER_QUERY,
    );
    expect(listInfraCollectRuns('proj-a', -1)).toHaveLength(5);
  });
});

describe('listScopeResourceCounts', () => {
  const STALE_MS = 24 * 60 * 60 * 1000;

  function scope(over: Record<string, unknown> = {}): void {
    getInfraDb()
      .prepare(
        `INSERT INTO infra_scopes
           (id, project_id, profile_name, account_id, region, service, enabled, created_at, updated_at)
         VALUES (@id, @project_id, @profile_name, @account_id, @region, @service, @enabled, @t, @t)`,
      )
      .run({
        id: 'scope-1',
        project_id: 'proj-a',
        profile_name: 'monitoring',
        account_id: null,
        region: 'us-east-1',
        service: 'ec2',
        enabled: 1,
        t: NOW,
        ...over,
      });
  }

  function resource(resourceId: string, over: Record<string, unknown> = {}): void {
    const identity = {
      projectId: 'proj-a',
      accountId: '111122223333',
      region: 'us-east-1',
      service: 'ec2',
      resourceId,
    };
    getInfraDb()
      .prepare(
        `INSERT INTO infra_resources
           (resource_key, project_id, account_id, region, service, resource_id, state, first_seen, last_seen)
         VALUES (@resource_key, @project_id, @account_id, @region, @service, @resource_id, @state, @first_seen, @last_seen)`,
      )
      .run({
        resource_key: infraResourceKey(identity),
        project_id: identity.projectId,
        account_id: identity.accountId,
        region: identity.region,
        service: identity.service,
        resource_id: resourceId,
        state: 'running',
        first_seen: NOW - 10_000,
        last_seen: NOW - 1_000,
        ...over,
      });
  }

  it('counts the population the collector will actually bill for', () => {
    scope();
    resource('i-1');
    resource('i-2');
    // Terminated and long-unseen rows are kept in inventory so a chart retains
    // its subject, but the collector does not poll them — so they must not be
    // priced either.
    resource('i-3', { state: 'terminated' });
    resource('i-4', { last_seen: NOW - STALE_MS - 1 });

    const counts = listScopeResourceCounts('proj-a', STALE_MS, NOW);
    expect(counts).toHaveLength(1);
    expect(counts[0]).toMatchObject({
      id: 'scope-1',
      service: 'ec2',
      region: 'us-east-1',
      profileName: 'monitoring',
      resourceCount: 2,
    });
  });

  it('skips disabled scopes', () => {
    scope({ enabled: 0 });
    resource('i-1');
    expect(listScopeResourceCounts('proj-a', STALE_MS, NOW)).toEqual([]);
  });

  it('narrows to the scope account once one is resolved', () => {
    scope({ account_id: '999988887777' });
    resource('i-1');
    expect(listScopeResourceCounts('proj-a', STALE_MS, NOW)[0].resourceCount).toBe(0);
  });

  it('returns a zero count for a scope whose inventory has not synced yet', () => {
    scope();
    const counts = listScopeResourceCounts('proj-a', STALE_MS, NOW);
    expect(counts[0].resourceCount).toBe(0);
  });
});
