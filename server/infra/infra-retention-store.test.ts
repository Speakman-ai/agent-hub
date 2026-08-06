/**
 * Retention store: config resolution with defaults, clamping on both write and
 * read, the byte accounting the quota pass spends against, and the two bounded
 * deletes themselves.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, getInfraDb, closeInfraDb, infraResourceKey } from './infra-db.js';
import { insertInfraMetricPoints } from './infra-metric-store.js';
import {
  getInfraRetentionConfig,
  setInfraRetentionConfig,
  listInfraRetentionOverrides,
  clampInfraRetentionDays,
  clampInfraQuotaBytes,
  getInfraProjectByteSize,
  listInfraProjectUsage,
  getInfraDbFileBytes,
  pruneExpiredInfraMetricPoints,
  enforceInfraProjectQuota,
} from './infra-retention-store.js';
import {
  DEFAULT_INFRA_RETENTION_DAYS,
  DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  MIN_INFRA_RETENTION_DAYS,
  MAX_INFRA_RETENTION_DAYS,
  MIN_INFRA_PROJECT_QUOTA_BYTES,
  MAX_INFRA_PROJECT_QUOTA_BYTES,
} from './infra-schema.js';

let dir: string;

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-retention-store-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function key(projectId: string, resourceId = 'i-1'): string {
  return infraResourceKey({
    projectId,
    accountId: '111122223333',
    region: 'us-east-2',
    service: 'ec2',
    resourceId,
  });
}

/** Write `count` points for a project, each `ageDays` old, one per minute back. */
function seed(projectId: string, count: number, ageDays: number, metricName = 'CPUUtilization') {
  const base = NOW - ageDays * DAY_MS;
  insertInfraMetricPoints(
    Array.from({ length: count }, (_, i) => ({
      projectId,
      resourceKey: key(projectId),
      namespace: 'AWS/EC2',
      metricName,
      dimensions: { InstanceId: 'i-1' },
      stat: 'Average',
      periodSeconds: 60,
      tsMs: base - i * 60_000,
      value: i,
    })),
  );
}

function pointCount(projectId: string): number {
  return (
    getInfraDb()
      .prepare('SELECT COUNT(*) AS n FROM infra_metric_points WHERE project_id = ?')
      .get(projectId) as { n: number }
  ).n;
}

describe('retention config resolution', () => {
  it('falls back to code defaults when a project has no row', () => {
    const cfg = getInfraRetentionConfig('p-none');
    expect(cfg).toMatchObject({
      projectId: 'p-none',
      retentionDays: DEFAULT_INFRA_RETENTION_DAYS,
      quotaBytes: DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
      updatedAt: null,
      configured: false,
    });
    // The default is resolved, never stored — an untouched project keeps no row.
    expect(listInfraRetentionOverrides()).toEqual([]);
  });

  it('round-trips an override and marks it configured', () => {
    const saved = setInfraRetentionConfig('p1', { retentionDays: 60, quotaBytes: 1 << 30 }, NOW);
    expect(saved).toMatchObject({ retentionDays: 60, quotaBytes: 1 << 30, configured: true });
    expect(getInfraRetentionConfig('p1')).toMatchObject({
      retentionDays: 60,
      quotaBytes: 1 << 30,
      updatedAt: NOW,
      configured: true,
    });
  });

  it('leaves the unspecified half of a partial update alone', () => {
    setInfraRetentionConfig('p1', { retentionDays: 60, quotaBytes: 1 << 30 }, NOW);
    const after = setInfraRetentionConfig('p1', { retentionDays: 10 }, NOW + 1);
    expect(after.retentionDays).toBe(10);
    expect(after.quotaBytes).toBe(1 << 30);
  });

  it('clamps out-of-range values on write instead of rejecting them', () => {
    const low = setInfraRetentionConfig('p-low', { retentionDays: 0, quotaBytes: 1 }, NOW);
    expect(low.retentionDays).toBe(MIN_INFRA_RETENTION_DAYS);
    expect(low.quotaBytes).toBe(MIN_INFRA_PROJECT_QUOTA_BYTES);

    const high = setInfraRetentionConfig(
      'p-high',
      { retentionDays: 10_000, quotaBytes: Number.MAX_SAFE_INTEGER },
      NOW,
    );
    expect(high.retentionDays).toBe(MAX_INFRA_RETENTION_DAYS);
    expect(high.quotaBytes).toBe(MAX_INFRA_PROJECT_QUOTA_BYTES);
  });

  it('re-clamps a stored row on read, so narrowing a bound reinterprets old rows', () => {
    // Written directly, bypassing the setter's clamp, to stand in for a row
    // stored while the documented bounds were wider.
    getInfraDb()
      .prepare(
        `INSERT INTO infra_retention_config (project_id, retention_days, quota_bytes, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run('p-legacy', 9_999, 1, NOW);

    const cfg = getInfraRetentionConfig('p-legacy');
    expect(cfg.retentionDays).toBe(MAX_INFRA_RETENTION_DAYS);
    expect(cfg.quotaBytes).toBe(MIN_INFRA_PROJECT_QUOTA_BYTES);
    expect(listInfraRetentionOverrides()[0]?.retentionDays).toBe(MAX_INFRA_RETENTION_DAYS);
  });

  it('clamps non-finite input to the defaults', () => {
    expect(clampInfraRetentionDays(Number.NaN)).toBe(DEFAULT_INFRA_RETENTION_DAYS);
    expect(clampInfraQuotaBytes(Number.POSITIVE_INFINITY)).toBe(DEFAULT_INFRA_PROJECT_QUOTA_BYTES);
  });
});

describe('byte accounting', () => {
  it('counts UTF-8 bytes, not characters', () => {
    // Two projects with identical row shapes except that one carries a
    // multi-byte dimension value. length() over TEXT would score them equal.
    const ascii = { InstanceId: 'aaaa' };
    const wide = { InstanceId: 'éééé' }; // 4 chars, 8 bytes
    // Same-length project ids, so the only difference between the two rows is
    // the dimension value's encoding.
    for (const [projectId, dimensions] of [
      ['p-narrow', ascii],
      ['p-wide-x', wide],
    ] as const) {
      insertInfraMetricPoints([
        {
          projectId,
          resourceKey: 'k',
          namespace: 'AWS/EC2',
          metricName: 'CPUUtilization',
          dimensions,
          stat: 'Average',
          periodSeconds: 60,
          tsMs: NOW,
          value: 1,
        },
      ]);
    }
    expect(getInfraProjectByteSize('p-wide-x')).toBe(getInfraProjectByteSize('p-narrow') + 4);
  });

  it('reports zero for a project holding nothing', () => {
    expect(getInfraProjectByteSize('p-empty')).toBe(0);
  });

  it('groups usage per project in one pass', () => {
    seed('p1', 5, 1);
    seed('p2', 3, 1);
    const usage = listInfraProjectUsage().sort((a, b) => a.projectId.localeCompare(b.projectId));
    expect(usage.map((u) => [u.projectId, u.points])).toEqual([
      ['p1', 5],
      ['p2', 3],
    ]);
    expect(usage[0]!.bytes).toBe(getInfraProjectByteSize('p1'));
    expect(usage[0]!.bytes).toBeGreaterThan(0);
  });

  it('reports the whole-file size as a positive page multiple', () => {
    seed('p1', 10, 1);
    const bytes = getInfraDbFileBytes();
    expect(bytes).toBeGreaterThan(0);
    expect(bytes % 512).toBe(0);
  });
});

describe('pruneExpiredInfraMetricPoints', () => {
  it('deletes points past the default window and keeps everything inside it', () => {
    seed('p1', 4, DEFAULT_INFRA_RETENTION_DAYS + 5);
    seed('p1', 6, 1);
    expect(pointCount('p1')).toBe(10);

    expect(pruneExpiredInfraMetricPoints(NOW, 1000)).toBe(4);
    expect(pointCount('p1')).toBe(6);
    // Idempotent: a second tick with nothing expired deletes nothing.
    expect(pruneExpiredInfraMetricPoints(NOW, 1000)).toBe(0);
  });

  it('honours a per-project override in both directions', () => {
    // p-short keeps 1 day, p-long keeps 365 — both hold points 10 days old.
    setInfraRetentionConfig('p-short', { retentionDays: 1 }, NOW);
    setInfraRetentionConfig('p-long', { retentionDays: 365 }, NOW);
    seed('p-short', 3, 10);
    seed('p-long', 3, 10);
    seed('p-default', 3, 10);

    expect(pruneExpiredInfraMetricPoints(NOW, 1000)).toBe(3);
    expect(pointCount('p-short')).toBe(0);
    expect(pointCount('p-long')).toBe(3);
    // 10 days is inside the 30-day default.
    expect(pointCount('p-default')).toBe(3);
  });

  it('does not let a long-override project starve the pass', () => {
    // The regression this guards: a single global query using the loosest
    // cutoff would return p-long's very old (but not expired) points first,
    // spend the budget skipping them, and never reach p-short's expired rows.
    setInfraRetentionConfig('p-long', { retentionDays: 365 }, NOW);
    setInfraRetentionConfig('p-short', { retentionDays: 1 }, NOW);
    seed('p-long', 50, 300);
    seed('p-short', 5, 10);

    expect(pruneExpiredInfraMetricPoints(NOW, 10)).toBe(5);
    expect(pointCount('p-short')).toBe(0);
    expect(pointCount('p-long')).toBe(50);
  });

  it('respects the delete budget and drains the remainder next tick', () => {
    seed('p1', 25, DEFAULT_INFRA_RETENTION_DAYS + 5);
    expect(pruneExpiredInfraMetricPoints(NOW, 10)).toBe(10);
    expect(pointCount('p1')).toBe(15);
    expect(pruneExpiredInfraMetricPoints(NOW, 10)).toBe(10);
    expect(pruneExpiredInfraMetricPoints(NOW, 10)).toBe(5);
    expect(pointCount('p1')).toBe(0);
  });

  it('deletes oldest-first across projects', () => {
    seed('p-older', 3, 90);
    seed('p-newer', 3, 40);
    // Budget of 3 must go to the genuinely oldest points, not to whichever
    // project SQLite happens to visit first.
    expect(pruneExpiredInfraMetricPoints(NOW, 3)).toBe(3);
    expect(pointCount('p-older')).toBe(0);
    expect(pointCount('p-newer')).toBe(3);
  });

  it('is a no-op with a zero or negative budget', () => {
    seed('p1', 5, 90);
    expect(pruneExpiredInfraMetricPoints(NOW, 0)).toBe(0);
    expect(pointCount('p1')).toBe(5);
  });

  it('deletes across chunk boundaries', () => {
    // 2,500 rows crosses the 2,000-row delete chunk, exercising both the
    // fixed-width chunk statement and the remainder statement.
    seed('p1', 2_500, DEFAULT_INFRA_RETENTION_DAYS + 5);
    expect(pruneExpiredInfraMetricPoints(NOW, 5_000)).toBe(2_500);
    expect(pointCount('p1')).toBe(0);
  });
});

describe('query plans', () => {
  /**
   * Every scan the reaper issues has to be an ordered index range. The failure
   * mode these guard is silent: without the right index SQLite still returns
   * correct rows, it just sorts the project's entire history into a temp b-tree
   * first — on every tick, on a table expected to hold tens of millions of
   * points. A plan regression is a performance cliff with no test failure
   * anywhere else, so it is asserted directly.
   */
  function plan(sql: string, ...bind: unknown[]): string {
    const rows = getInfraDb()
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(...(bind as never[])) as Array<{ detail: string }>;
    return rows.map((r) => r.detail).join(' | ');
  }

  it('walks the global ts index for the default-window age pass', () => {
    const detail = plan(
      'SELECT id FROM infra_metric_points WHERE ts_ms < ? ORDER BY ts_ms ASC LIMIT ?',
      0,
      1,
    );
    expect(detail).toContain('idx_infra_metric_points_ts');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('still walks the global ts index when overriding projects are excluded', () => {
    const detail = plan(
      `SELECT id FROM infra_metric_points
        WHERE ts_ms < ? AND project_id NOT IN (?, ?)
        ORDER BY ts_ms ASC LIMIT ?`,
      0,
      'a',
      'b',
      1,
    );
    expect(detail).toContain('idx_infra_metric_points_ts');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('walks the per-project ts index for an overriding project', () => {
    const detail = plan(
      `SELECT id FROM infra_metric_points
        WHERE project_id = ? AND ts_ms < ?
        ORDER BY ts_ms ASC LIMIT ?`,
      'a',
      0,
      1,
    );
    expect(detail).toContain('idx_infra_metric_points_project_ts');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('walks the per-project ts index for quota eviction', () => {
    const detail = plan(
      'SELECT id FROM infra_metric_points WHERE project_id = ? ORDER BY ts_ms ASC LIMIT ?',
      'a',
      1,
    );
    expect(detail).toContain('idx_infra_metric_points_project_ts');
    expect(detail).not.toContain('TEMP B-TREE');
  });

  it('sorts when several projects are batched into one IN, which is why they are not', () => {
    // Documents the reason the age pass issues one query per overriding project
    // rather than a single `IN (...)`: the batched form loses the index order.
    const detail = plan(
      `SELECT id FROM infra_metric_points
        WHERE ts_ms < ? AND project_id IN (?, ?, ?)
        ORDER BY ts_ms ASC LIMIT ?`,
      0,
      'a',
      'b',
      'c',
      1,
    );
    expect(detail).toContain('TEMP B-TREE');
  });
});

describe('enforceInfraProjectQuota', () => {
  /**
   * Enough points to clear the 1 MiB quota floor, so eviction is exercised
   * through the real configured quota rather than an injected total. These
   * rows account at ~163 bytes each (their resource keys are short), so 10k is
   * comfortably over while staying fast to insert.
   */
  const OVER_QUOTA_POINTS = 10_000;

  it('evicts oldest points until the project is back under its configured quota', () => {
    seed('p1', OVER_QUOTA_POINTS, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    expect(getInfraProjectByteSize('p1')).toBeGreaterThan(MIN_INFRA_PROJECT_QUOTA_BYTES);

    const deleted = enforceInfraProjectQuota('p1', OVER_QUOTA_POINTS);
    expect(deleted).toBeGreaterThan(0);
    expect(getInfraProjectByteSize('p1')).toBeLessThanOrEqual(MIN_INFRA_PROJECT_QUOTA_BYTES);
    // Only the excess goes: what fits inside the quota is kept.
    expect(pointCount('p1')).toBe(OVER_QUOTA_POINTS - deleted);
    expect(pointCount('p1')).toBeGreaterThan(0);

    // A second call on a project now inside its quota is a no-op.
    expect(enforceInfraProjectQuota('p1', OVER_QUOTA_POINTS)).toBe(0);
  });

  it('evicts oldest-by-timestamp first, keeping the newest points', () => {
    // `seed` walks backwards in time as it inserts, so the oldest point has the
    // *highest* rowid. Eviction that followed insertion order would keep the
    // wrong end of the series; this asserts it follows ts_ms.
    seed('p1', OVER_QUOTA_POINTS, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    const span = () =>
      getInfraDb()
        .prepare('SELECT MIN(ts_ms) AS lo, MAX(ts_ms) AS hi FROM infra_metric_points')
        .get() as { lo: number; hi: number };
    const before = span();

    enforceInfraProjectQuota('p1', OVER_QUOTA_POINTS);

    const after = span();
    expect(after.lo).toBeGreaterThan(before.lo);
    expect(after.hi).toBe(before.hi);
  });

  it('respects the delete budget', () => {
    seed('p1', OVER_QUOTA_POINTS, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    expect(enforceInfraProjectQuota('p1', 3)).toBe(3);
    expect(pointCount('p1')).toBe(OVER_QUOTA_POINTS - 3);
  });

  it('does nothing for a project inside its quota', () => {
    seed('p1', 10, 1);
    expect(enforceInfraProjectQuota('p1', 1000)).toBe(0);
    expect(pointCount('p1')).toBe(10);
  });

  it('trusts a precomputed total instead of re-aggregating the table', () => {
    // The path the reaper takes: it already summed every project in one grouped
    // scan, so passing the total avoids a second scan per over-quota project.
    // A handful of rows plus an inflated total exercises it without the volume
    // the real-quota tests above need.
    seed('p1', 20, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    const inflated = MIN_INFRA_PROJECT_QUOTA_BYTES * 100;
    expect(enforceInfraProjectQuota('p1', 5, inflated)).toBe(5);
    expect(pointCount('p1')).toBe(15);
  });

  it('only touches the named project', () => {
    seed('p1', 10, 1);
    seed('p2', 10, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    enforceInfraProjectQuota('p1', 5, MIN_INFRA_PROJECT_QUOTA_BYTES * 100);
    expect(pointCount('p1')).toBe(5);
    expect(pointCount('p2')).toBe(10);
  });

  it('is a no-op with a zero budget', () => {
    seed('p1', 20, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    expect(enforceInfraProjectQuota('p1', 0, MIN_INFRA_PROJECT_QUOTA_BYTES * 100)).toBe(0);
    expect(pointCount('p1')).toBe(20);
  });
});
