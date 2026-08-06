/**
 * Metric-point store: overlap idempotence, the natural series key, validation
 * that drops a point instead of a batch, the commit-then-publish contract, and
 * the collect-run audit trail.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { INFRA_EMPTY_DIMENSIONS_HASH } from './infra-schema.js';
import {
  insertInfraMetricPoints,
  queryInfraMetricPoints,
  countInfraMetricPoints,
  infraDimensionsHash,
  isValidCloudWatchPeriod,
  startInfraCollectRun,
  finishInfraCollectRun,
  MAX_METRIC_POINTS_PER_QUERY,
  type InfraMetricPointInput,
} from './infra-metric-store.js';

let dir: string;

const RESOURCE = infraResourceKey({
  projectId: 'proj-a',
  accountId: '111122223333',
  region: 'us-east-1',
  service: 'ec2',
  resourceId: 'i-0abc',
});

function point(over: Partial<InfraMetricPointInput> = {}): InfraMetricPointInput {
  return {
    projectId: 'proj-a',
    resourceKey: RESOURCE,
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    periodSeconds: 300,
    tsMs: 1_700_000_000_000,
    value: 12.5,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-metric-store-test-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('insertInfraMetricPoints', () => {
  it('writes a batch and returns the committed rows', () => {
    const result = insertInfraMetricPoints([
      point({ tsMs: 1_000, value: 1 }),
      point({ tsMs: 2_000, value: 2 }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.rejected).toBe(0);
    expect(result.points).toHaveLength(2);
    expect(result.points.every((p) => Number.isInteger(p.id) && p.id > 0)).toBe(true);
    expect(countInfraMetricPoints('proj-a')).toBe(2);
  });

  it('is idempotent across an overlapping re-collection (no duplicate points)', () => {
    // First tick: 10:00–10:20 at 300s.
    const first = [0, 300, 600, 900].map((offset) =>
      point({ tsMs: 1_700_000_000_000 + offset * 1000, value: offset }),
    );
    expect(insertInfraMetricPoints(first).inserted).toBe(4);

    // Retry overlaps the last two datapoints and extends past them.
    const second = [600, 900, 1200, 1500].map((offset) =>
      point({ tsMs: 1_700_000_000_000 + offset * 1000, value: offset }),
    );
    expect(insertInfraMetricPoints(second).inserted).toBe(4);

    // 4 + 4 with a 2-point overlap = 6 distinct points, not 8.
    expect(countInfraMetricPoints('proj-a')).toBe(6);
  });

  it('corrects the value in place when CloudWatch revises a datapoint', () => {
    insertInfraMetricPoints([point({ tsMs: 5_000, value: 1 })]);
    insertInfraMetricPoints([point({ tsMs: 5_000, value: 99 })]);

    const rows = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 10_000,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe(99);
  });

  it('keeps the same metric on two stats or two periods as distinct series', () => {
    insertInfraMetricPoints([
      point({ tsMs: 5_000, stat: 'Average', periodSeconds: 300, value: 1 }),
      point({ tsMs: 5_000, stat: 'Maximum', periodSeconds: 300, value: 2 }),
      point({ tsMs: 5_000, stat: 'Average', periodSeconds: 60, value: 3 }),
    ]);
    expect(countInfraMetricPoints('proj-a')).toBe(3);
  });

  it('keeps two dimension sets on the same metric as distinct series', () => {
    insertInfraMetricPoints([
      point({ tsMs: 5_000, dimensions: { AutoScalingGroupName: 'asg-a' }, value: 1 }),
      point({ tsMs: 5_000, dimensions: { AutoScalingGroupName: 'asg-b' }, value: 2 }),
      point({ tsMs: 5_000, value: 3 }),
    ]);
    expect(countInfraMetricPoints('proj-a')).toBe(3);
  });

  it('drops a malformed point without losing the rest of the batch', () => {
    const result = insertInfraMetricPoints([
      point({ tsMs: 1_000, value: 1 }),
      // CloudWatch expression results can come back as NaN; a NOT NULL REAL
      // column would take the whole transaction down with it.
      point({ tsMs: 2_000, value: Number.NaN }),
      point({ tsMs: 3_000, value: Number.POSITIVE_INFINITY }),
      point({ tsMs: 4_000, periodSeconds: 0 }),
      point({ tsMs: 5_000, resourceKey: '' }),
      point({ tsMs: 6_000, value: 6 }),
    ]);
    expect(result.inserted).toBe(2);
    expect(result.rejected).toBe(4);
    expect(countInfraMetricPoints('proj-a')).toBe(2);
  });

  it('rejects a fractional period instead of flooring it into a phantom series', () => {
    // Regression: `periodSeconds: 0.5` passed a `> 0` check and was then
    // floored to `period_s = 0` — not a period CloudWatch can return, and
    // indistinguishable from real data once stored.
    const result = insertInfraMetricPoints([
      point({ tsMs: 1_000, periodSeconds: 0.5 }),
      point({ tsMs: 2_000, periodSeconds: 59.9 }),
      point({ tsMs: 3_000, periodSeconds: 300.5 }),
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(3);
    expect(countInfraMetricPoints('proj-a')).toBe(0);

    const periods = getInfraDb()
      .prepare('SELECT DISTINCT period_s FROM infra_metric_points')
      .all() as { period_s: number }[];
    expect(periods).toEqual([]);
  });

  it('rejects a period CloudWatch would not accept', () => {
    // Not a multiple of 60 and not one of the high-resolution values.
    const result = insertInfraMetricPoints([
      point({ tsMs: 1_000, periodSeconds: 45 }),
      point({ tsMs: 2_000, periodSeconds: 90 }),
      point({ tsMs: 3_000, periodSeconds: 0 }),
      point({ tsMs: 4_000, periodSeconds: -60 }),
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(4);
  });

  it('accepts every period CloudWatch documents', () => {
    // High-resolution values plus the standard multiples of 60.
    const valid = [1, 5, 10, 20, 30, 60, 300, 3_600, 86_400];
    const result = insertInfraMetricPoints(
      valid.map((periodSeconds, i) => point({ tsMs: 1_000 * (i + 1), periodSeconds })),
    );
    expect(result.inserted).toBe(valid.length);
    expect(result.rejected).toBe(0);
  });

  it('rejects a fractional or non-positive timestamp', () => {
    const result = insertInfraMetricPoints([
      point({ tsMs: 1_000.5 }),
      point({ tsMs: 0 }),
      point({ tsMs: -1_000 }),
    ]);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(3);
  });

  it('collapses duplicate series keys inside one batch, last value wins', () => {
    // Two overlapping ticks land the same (series, timestamp) in one flush
    // window. Stepping the upsert three times would report three written rows
    // where one exists, inflating the INFRA-COST audit.
    const result = insertInfraMetricPoints([
      point({ tsMs: 5_000, value: 10 }),
      point({ tsMs: 5_000, value: 20 }),
      point({ tsMs: 5_000, value: 30 }),
    ]);
    expect(result.inserted).toBe(1);
    expect(result.points).toHaveLength(1);
    expect(result.points[0].value).toBe(30);
    expect(countInfraMetricPoints('proj-a')).toBe(1);

    // Nothing superseded is published: an alert evaluator must never see 10 or
    // 20, neither of which is what the transaction durably wrote.
    const stored = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 10_000,
    });
    expect(stored.map((r) => r.value)).toEqual([30]);
    expect(result.points[0].id).toBe(stored[0].id);
  });

  it('does not collapse points that only look alike', () => {
    const result = insertInfraMetricPoints([
      point({ tsMs: 5_000, metricName: 'a|b', stat: 'c', value: 1 }),
      point({ tsMs: 5_000, metricName: 'a', stat: 'b|c', value: 2 }),
    ]);
    expect(result.inserted).toBe(2);
    expect(countInfraMetricPoints('proj-a')).toBe(2);
  });

  it('is a no-op on an empty batch', () => {
    const result = insertInfraMetricPoints([]);
    expect(result).toEqual({ inserted: 0, rejected: 0, points: [] });
  });

  it('stores dimensions as canonical JSON with a stable hash', () => {
    const [row] = insertInfraMetricPoints([point({ dimensions: { B: '2', A: '1' } })]).points;
    expect(row.dimensionsJson).toBe('{"A":"1","B":"2"}');
    expect(row.dimensionsHash).toBe(infraDimensionsHash({ A: '1', B: '2' }));
  });
});

describe('isValidCloudWatchPeriod', () => {
  // AWS MetricStat.Period, verified against the API reference Aug 2026:
  // "the period can be 1, 5, 10, 20, 30, 60, or any multiple of 60",
  // Type Integer, valid range minimum 1.
  it('accepts the documented high-resolution values', () => {
    for (const p of [1, 5, 10, 20, 30]) expect(isValidCloudWatchPeriod(p)).toBe(true);
  });

  it('accepts any multiple of 60, including the three collector tiers', () => {
    for (const p of [60, 120, 300, 3_600, 86_400]) expect(isValidCloudWatchPeriod(p)).toBe(true);
  });

  it('rejects sub-minute values outside the high-resolution set', () => {
    for (const p of [2, 15, 45, 59]) expect(isValidCloudWatchPeriod(p)).toBe(false);
  });

  it('rejects non-integers, zero and negatives', () => {
    for (const p of [0, -1, -60, 0.5, 59.9, 60.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidCloudWatchPeriod(p)).toBe(false);
    }
  });

  it('imposes no upper bound, because AWS documents none', () => {
    expect(isValidCloudWatchPeriod(60 * 60 * 24 * 30)).toBe(true);
  });
});

describe('infraDimensionsHash', () => {
  it('uses the sentinel for an absent or empty dimension set', () => {
    expect(infraDimensionsHash()).toBe(INFRA_EMPTY_DIMENSIONS_HASH);
    expect(infraDimensionsHash(null)).toBe(INFRA_EMPTY_DIMENSIONS_HASH);
    expect(infraDimensionsHash({})).toBe(INFRA_EMPTY_DIMENSIONS_HASH);
  });

  it('is order-independent', () => {
    expect(infraDimensionsHash({ A: '1', B: '2' })).toBe(infraDimensionsHash({ B: '2', A: '1' }));
  });

  it('does not collide across a key/value boundary shift', () => {
    // Length-prefixing is what stops {"ab":"c"} and {"a":"bc"} canonicalizing
    // to the same string and merging two series into one chart.
    expect(infraDimensionsHash({ ab: 'c' })).not.toBe(infraDimensionsHash({ a: 'bc' }));
  });
});

describe('queryInfraMetricPoints', () => {
  beforeEach(() => {
    insertInfraMetricPoints(
      Array.from({ length: 10 }, (_, i) => point({ tsMs: 1_000 * (i + 1), value: i })),
    );
  });

  it('returns a bounded range oldest-first', () => {
    const rows = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 3_000,
      endMs: 6_000,
    });
    expect(rows.map((r) => r.tsMs)).toEqual([3_000, 4_000, 5_000, 6_000]);
  });

  it('truncates the far end of the range, not the recent end, when limited', () => {
    const rows = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 100_000,
      limit: 3,
    });
    expect(rows.map((r) => r.tsMs)).toEqual([8_000, 9_000, 10_000]);
  });

  it('clamps an oversized limit', () => {
    const rows = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 100_000,
      limit: MAX_METRIC_POINTS_PER_QUERY * 100,
    });
    expect(rows).toHaveLength(10);
  });

  it('isolates a single series only when namespace, stat, period and dimensions are all pinned', () => {
    // Four rows the writer deliberately keeps distinct, all at one timestamp.
    insertInfraMetricPoints([
      point({ tsMs: 8_000, namespace: 'CWAgent', value: 111 }),
      point({ tsMs: 8_000, stat: 'Maximum', value: 222 }),
      point({ tsMs: 8_000, periodSeconds: 60, value: 333 }),
      point({ tsMs: 8_000, dimensions: { AutoScalingGroupName: 'asg-a' }, value: 444 }),
    ]);

    const base = {
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 7_999,
      endMs: 8_001,
    };
    // (project, resource, metric) alone is a union, not a series.
    expect(queryInfraMetricPoints(base)).toHaveLength(5);

    expect(
      queryInfraMetricPoints({
        ...base,
        namespace: 'AWS/EC2',
        stat: 'Average',
        periodSeconds: 300,
        dimensionsHash: INFRA_EMPTY_DIMENSIONS_HASH,
      }).map((r) => r.value),
    ).toEqual([7]);

    expect(queryInfraMetricPoints({ ...base, namespace: 'CWAgent' }).map((r) => r.value)).toEqual([
      111,
    ]);
  });

  it('filters by stat, period and dimensions', () => {
    insertInfraMetricPoints([
      point({ tsMs: 1_000, stat: 'Maximum', value: 500 }),
      point({ tsMs: 1_000, dimensions: { AutoScalingGroupName: 'asg-a' }, value: 700 }),
    ]);

    expect(
      queryInfraMetricPoints({
        projectId: 'proj-a',
        resourceKey: RESOURCE,
        metricName: 'CPUUtilization',
        startMs: 0,
        endMs: 2_000,
        stat: 'Maximum',
      }).map((r) => r.value),
    ).toEqual([500]);

    expect(
      queryInfraMetricPoints({
        projectId: 'proj-a',
        resourceKey: RESOURCE,
        metricName: 'CPUUtilization',
        startMs: 0,
        endMs: 2_000,
        dimensionsHash: infraDimensionsHash({ AutoScalingGroupName: 'asg-a' }),
      }).map((r) => r.value),
    ).toEqual([700]);

    expect(
      queryInfraMetricPoints({
        projectId: 'proj-a',
        resourceKey: RESOURCE,
        metricName: 'CPUUtilization',
        startMs: 0,
        endMs: 2_000,
        periodSeconds: 60,
      }),
    ).toEqual([]);
  });

  it('never leaks another project rows', () => {
    insertInfraMetricPoints([point({ projectId: 'proj-b', tsMs: 1_000, value: 42 })]);
    const rows = queryInfraMetricPoints({
      projectId: 'proj-b',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 100_000,
    });
    expect(rows.map((r) => r.value)).toEqual([42]);
    expect(countInfraMetricPoints('proj-a')).toBe(10);
  });
});

describe('infra_collect_runs audit', () => {
  it('opens a running row and closes it with counters and estimated cost', () => {
    startInfraCollectRun({
      id: 'run-1',
      projectId: 'proj-a',
      accountId: '111122223333',
      region: 'us-east-1',
      startedAt: 1_000,
    });

    const open = getInfraDb()
      .prepare('SELECT status, finished_at FROM infra_collect_runs WHERE id = ?')
      .get('run-1') as { status: string; finished_at: number | null };
    expect(open.status).toBe('running');
    expect(open.finished_at).toBeNull();

    finishInfraCollectRun('run-1', {
      finishedAt: 3_500,
      queriesIssued: 4,
      metricsRequested: 1_200,
      datapointsReturned: 900,
      pointsWritten: 900,
      throttles: 1,
      errors: 0,
      estimatedCostUsd: 0.0012,
      status: 'ok',
    });

    const closed = getInfraDb()
      .prepare('SELECT * FROM infra_collect_runs WHERE id = ?')
      .get('run-1') as Record<string, unknown>;
    expect(closed.status).toBe('ok');
    expect(closed.duration_ms).toBe(2_500);
    expect(closed.metrics_requested).toBe(1_200);
    expect(closed.estimated_cost_usd).toBeCloseTo(0.0012);
    expect(closed.throttles).toBe(1);
  });

  it('records a failed tick with its message', () => {
    startInfraCollectRun({ id: 'run-2', projectId: 'proj-a', startedAt: 1_000 });
    finishInfraCollectRun('run-2', {
      finishedAt: 1_200,
      status: 'failed',
      errorMessage: 'Throttling: Rate exceeded',
    });
    const row = getInfraDb()
      .prepare('SELECT status, error_message FROM infra_collect_runs WHERE id = ?')
      .get('run-2') as { status: string; error_message: string };
    expect(row.status).toBe('failed');
    expect(row.error_message).toBe('Throttling: Rate exceeded');
  });

  it('rejects an unknown status via the CHECK constraint', () => {
    expect(() =>
      getInfraDb()
        .prepare(
          `INSERT INTO infra_collect_runs (id, project_id, started_at, status)
           VALUES ('run-3', 'proj-a', 1, 'finished-ish')`,
        )
        .run(),
    ).toThrow();
  });
});
