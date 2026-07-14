import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  initLogsDb,
  closeLogsDb,
  getLogsDb,
  insertLogRecords,
  queryLogRecords,
  getProjectByteSize,
  isLogFtsAvailable,
  type LogRecordInput,
} from './logs-db.js';
import { runLogRetentionReaper } from './log-retention-reaper.js';
import { getLogMetrics, resetLogMetrics } from './log-metrics.js';
import { SEVERITY_NUMBER, DEFAULT_RETENTION_DAYS } from './logs-schema.js';

/** Write a retention-config row directly, bypassing the operator clamp floor. */
function forceQuota(projectId: string, quotaBytes: number): void {
  getLogsDb()
    .prepare(
      `INSERT INTO log_retention_config (project_id, retention_days, quota_bytes, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id) DO UPDATE SET quota_bytes = excluded.quota_bytes`,
    )
    .run(projectId, DEFAULT_RETENTION_DAYS, quotaBytes, NOW);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function nanoAgo(ageDays: number): number {
  return (NOW - ageDays * DAY_MS) * 1_000_000;
}

function rec(over: Partial<LogRecordInput> = {}): LogRecordInput {
  return {
    projectId: 'proj-a',
    sourceId: 'src-1',
    timeUnixNano: nanoAgo(0),
    severityNumber: SEVERITY_NUMBER.INFO,
    body: 'hello',
    ...over,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'log-reaper-test-'));
  initLogsDb(dir);
  resetLogMetrics();
});

afterEach(() => {
  closeLogsDb();
  rmSync(dir, { recursive: true, force: true });
});

describe('runLogRetentionReaper', () => {
  it('deletes only records past the project retention window and counts the metric', () => {
    insertLogRecords(
      [
        rec({ body: 'fresh', timeUnixNano: nanoAgo(1) }),
        rec({ body: 'stale-1', timeUnixNano: nanoAgo(10) }),
        rec({ body: 'stale-2', timeUnixNano: nanoAgo(30) }),
      ],
      NOW,
    );

    const result = runLogRetentionReaper(NOW);
    expect(result.expiredDeleted).toBe(2); // default 7-day window

    const bodies = queryLogRecords({ projectId: 'proj-a', limit: 10 }).records.map((r) => r.body);
    expect(bodies).toEqual(['fresh']);
    expect(getLogMetrics().expiredDeleted).toBe(2);
  });

  it('keeps the FTS index aligned after an expiry reap (deleted bodies are unsearchable)', () => {
    if (!isLogFtsAvailable()) return; // FTS optional at the SQLite-build level
    insertLogRecords(
      [
        rec({ body: 'keepable message', timeUnixNano: nanoAgo(1) }),
        rec({ body: 'expirable message', timeUnixNano: nanoAgo(30) }),
      ],
      NOW,
    );

    runLogRetentionReaper(NOW);

    expect(
      queryLogRecords({ projectId: 'proj-a', text: 'expirable', limit: 5 }).records,
    ).toHaveLength(0);
    expect(
      queryLogRecords({ projectId: 'proj-a', text: 'keepable', limit: 5 }).records,
    ).toHaveLength(1);
  });

  it('evicts oldest records down to the per-project byte quota and counts the metric', () => {
    // Each ~1 KiB body; a 3 KiB quota keeps roughly the newest three.
    const body = 'q'.repeat(1024);
    const records = Array.from({ length: 8 }, (_, i) =>
      rec({ body, timeUnixNano: nanoAgo(i / 24) }),
    );
    insertLogRecords(records, NOW);
    // Tiny quota set directly (below the 64 MiB clamp floor) to exercise
    // eviction without writing 64 MiB of test data.
    forceQuota('proj-a', 3 * 1024);

    const result = runLogRetentionReaper(NOW);
    expect(result.quotaDeleted).toBeGreaterThan(0);
    expect(getProjectByteSize('proj-a')).toBeLessThanOrEqual(3 * 1024);
    expect(getLogMetrics().quotaDeleted).toBe(result.quotaDeleted);
  });

  it('shares one delete budget across the expiry and quota passes and drains over ticks', () => {
    // 6 expired records; a 4-delete budget must not exceed 4 in one tick, and
    // the remainder drains on the next tick (restart-safe backlog handling).
    insertLogRecords(
      Array.from({ length: 6 }, () => rec({ timeUnixNano: nanoAgo(30) })),
      NOW,
    );

    const first = runLogRetentionReaper(NOW, 4);
    expect(first.expiredDeleted).toBe(4);

    const second = runLogRetentionReaper(NOW, 4);
    expect(second.expiredDeleted).toBe(2);

    expect(runLogRetentionReaper(NOW, 4)).toEqual({ expiredDeleted: 0, quotaDeleted: 0 });
    expect(queryLogRecords({ projectId: 'proj-a', limit: 10 }).records).toHaveLength(0);
  });

  it('is a no-op on an empty store', () => {
    expect(runLogRetentionReaper(NOW)).toEqual({ expiredDeleted: 0, quotaDeleted: 0 });
  });
});
