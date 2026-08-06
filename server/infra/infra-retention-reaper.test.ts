/**
 * Reaper tick: the two passes, the budget they share, the cheap gate that keeps
 * the quota scan off a small store, and the no-op when `infra.db` never opened.
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
  getInfraProjectByteSize,
} from './infra-retention-store.js';
import { runInfraRetentionReaper, INFRA_RETENTION_REAPER_CRON } from './infra-retention-reaper.js';
import {
  DEFAULT_INFRA_RETENTION_DAYS,
  DEFAULT_INFRA_PROJECT_QUOTA_BYTES,
  MIN_INFRA_PROJECT_QUOTA_BYTES,
} from './infra-schema.js';

let dir: string;

const NOW = Date.UTC(2026, 7, 15, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'infra-reaper-'));
  initInfraDb(dir);
});

afterEach(() => {
  closeInfraDb();
  rmSync(dir, { recursive: true, force: true });
});

function seed(projectId: string, count: number, ageDays: number) {
  const base = NOW - ageDays * DAY_MS;
  insertInfraMetricPoints(
    Array.from({ length: count }, (_, i) => ({
      projectId,
      resourceKey: infraResourceKey({
        projectId,
        accountId: '111122223333',
        region: 'us-east-2',
        service: 'ec2',
        resourceId: 'i-1',
      }),
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
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

describe('runInfraRetentionReaper', () => {
  it('is scheduled on a valid ten-minute cron', () => {
    expect(INFRA_RETENTION_REAPER_CRON).toBe('*/10 * * * *');
  });

  it('deletes only points past the project window', () => {
    seed('p1', 3, 1);
    seed('p1', 4, DEFAULT_INFRA_RETENTION_DAYS + 2);

    const result = runInfraRetentionReaper(NOW);
    expect(result.expiredDeleted).toBe(4);
    expect(result.quotaDeleted).toBe(0);
    expect(pointCount('p1')).toBe(3);
  });

  it('falls back to the default window for a project with no config row', () => {
    // Nothing was ever written to infra_retention_config, so the 30-day default
    // is what decides: 29 days old survives, 31 does not.
    seed('p-fresh', 2, DEFAULT_INFRA_RETENTION_DAYS - 1);
    seed('p-stale', 2, DEFAULT_INFRA_RETENTION_DAYS + 1);
    expect(getInfraRetentionConfig('p-fresh').configured).toBe(false);
    expect(getInfraRetentionConfig('p-fresh').quotaBytes).toBe(DEFAULT_INFRA_PROJECT_QUOTA_BYTES);

    expect(runInfraRetentionReaper(NOW).expiredDeleted).toBe(2);
    expect(pointCount('p-fresh')).toBe(2);
    expect(pointCount('p-stale')).toBe(0);
  });

  it('honours a per-project override over the default', () => {
    setInfraRetentionConfig('p-short', { retentionDays: 2 }, NOW);
    seed('p-short', 5, 10);
    seed('p-default', 5, 10);

    expect(runInfraRetentionReaper(NOW).expiredDeleted).toBe(5);
    expect(pointCount('p-short')).toBe(0);
    expect(pointCount('p-default')).toBe(5);
  });

  it('shares one delete budget across both passes and drains over ticks', () => {
    seed('p1', 12, DEFAULT_INFRA_RETENTION_DAYS + 2);

    const first = runInfraRetentionReaper(NOW, 5);
    expect(first.expiredDeleted).toBe(5);
    // Budget exhausted by the age pass, so the quota pass never ran.
    expect(first.quotaDeleted).toBe(0);
    expect(first.quotaScanSkipped).toBe(true);
    expect(pointCount('p1')).toBe(7);

    expect(runInfraRetentionReaper(NOW, 5).expiredDeleted).toBe(5);
    expect(runInfraRetentionReaper(NOW, 5).expiredDeleted).toBe(2);
    expect(pointCount('p1')).toBe(0);
  });

  it('enforces the byte quota on points the age pass left behind', () => {
    // All inside the 30-day window, so the age pass deletes nothing and every
    // deletion below is the quota pass's doing.
    seed('p1', 10_000, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);
    expect(getInfraProjectByteSize('p1')).toBeGreaterThan(MIN_INFRA_PROJECT_QUOTA_BYTES);

    const result = runInfraRetentionReaper(NOW);
    expect(result.expiredDeleted).toBe(0);
    expect(result.quotaDeleted).toBeGreaterThan(0);
    expect(result.quotaScanSkipped).toBe(false);
    expect(getInfraProjectByteSize('p1')).toBeLessThanOrEqual(MIN_INFRA_PROJECT_QUOTA_BYTES);
    expect(pointCount('p1')).toBeGreaterThan(0);
  });

  it('spends the age pass first, then what is left on the quota pass', () => {
    seed('p1', 4, DEFAULT_INFRA_RETENTION_DAYS + 2);
    seed('p1', 10_000, 1);
    setInfraRetentionConfig('p1', { quotaBytes: MIN_INFRA_PROJECT_QUOTA_BYTES }, NOW);

    const result = runInfraRetentionReaper(NOW, 10);
    expect(result.expiredDeleted).toBe(4);
    expect(result.quotaDeleted).toBe(6);
    expect(pointCount('p1')).toBe(10_000 - 6);
  });

  it('skips the quota scan when the store is smaller than any configured quota', () => {
    // A handful of points inside the window: no project can be over an 8 GiB
    // default quota, and the tick proves it from the file size alone.
    seed('p1', 5, 1);
    const result = runInfraRetentionReaper(NOW);
    expect(result).toEqual({ expiredDeleted: 0, quotaDeleted: 0, quotaScanSkipped: true });
    expect(pointCount('p1')).toBe(5);
  });

  it('leaves the collect-run audit trail and the resource inventory alone', () => {
    // The cost surface sums month-to-date spend out of infra_collect_runs, and
    // a terminated resource has to fade from the UI rather than vanish, so
    // neither table is in this reaper's scope.
    const db = getInfraDb();
    db.prepare(
      `INSERT INTO infra_collect_runs (id, project_id, started_at, status, estimated_cost_usd)
       VALUES ('run-old', 'p1', ?, 'ok', 1.5)`,
    ).run(NOW - 400 * DAY_MS);
    db.prepare(
      `INSERT INTO infra_resources
         (resource_key, project_id, account_id, region, service, resource_id, first_seen, last_seen)
       VALUES ('rk', 'p1', '111122223333', 'us-east-2', 'ec2', 'i-1', ?, ?)`,
    ).run(NOW - 400 * DAY_MS, NOW - 400 * DAY_MS);
    seed('p1', 3, DEFAULT_INFRA_RETENTION_DAYS + 1);

    runInfraRetentionReaper(NOW);

    expect(pointCount('p1')).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM infra_collect_runs').get() as { n: number }).n,
    ).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM infra_resources').get() as { n: number }).n).toBe(
      1,
    );
  });

  it('is a no-op when infra.db never opened', () => {
    closeInfraDb();
    expect(runInfraRetentionReaper(NOW)).toEqual({
      expiredDeleted: 0,
      quotaDeleted: 0,
      quotaScanSkipped: true,
    });
    // Reopened so the shared afterEach teardown has a handle to close.
    initInfraDb(dir);
  });
});
