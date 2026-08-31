import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import os from 'os';
import path from 'path';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { enqueueRunnerJob, runnerJobLogStats } from './runner-queue.js';
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_ROWS,
  DEFAULT_RETENTION_DAYS,
  RUNNER_JOB_LOG_REAPER_CRON,
  resolveBatchSize,
  resolveMaxBatches,
  resolveMaxRows,
  resolveReaperCron,
  resolveRetentionMs,
  runRunnerJobLogReaper,
} from './runner-job-log-reaper.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function fileBytes(p: string): number {
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

function measureOrgsDb(dbPath: string): { dbBytes: number; walBytes: number; totalBytes: number } {
  const dbBytes = fileBytes(dbPath);
  const walBytes = fileBytes(`${dbPath}-wal`);
  return { dbBytes, walBytes, totalBytes: dbBytes + walBytes };
}

describe('resolveRetentionMs', () => {
  it('defaults to 1 day when the env var is unset', () => {
    expect(resolveRetentionMs({})).toBe(DEFAULT_RETENTION_DAYS * MS_PER_DAY);
  });

  it('honors a positive numeric override', () => {
    expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: '7' })).toBe(
      7 * MS_PER_DAY,
    );
  });

  it('honors a fractional override (e.g. 0.5 day)', () => {
    expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: '0.5' })).toBe(
      0.5 * MS_PER_DAY,
    );
  });

  it.each(['0', '-5', 'abc', ''])(
    'falls back to the default for invalid value %j (never collapses retention to zero)',
    (raw) => {
      expect(resolveRetentionMs({ FINALIZE_RUNNER_JOB_LOG_RETENTION_DAYS: raw })).toBe(
        DEFAULT_RETENTION_DAYS * MS_PER_DAY,
      );
    },
  );
});

describe('resolveMaxRows', () => {
  it('defaults to 1_000_000 when unset', () => {
    expect(resolveMaxRows({})).toBe(DEFAULT_MAX_ROWS);
  });

  it('honors a value at or above the 10_000 floor', () => {
    expect(resolveMaxRows({ FINALIZE_RUNNER_JOB_LOG_MAX_ROWS: '50000' })).toBe(50_000);
  });

  it.each(['0', '-1', 'abc', '100', '9999'])(
    'falls back to the default for invalid or below-floor value %j',
    (raw) => {
      expect(resolveMaxRows({ FINALIZE_RUNNER_JOB_LOG_MAX_ROWS: raw })).toBe(DEFAULT_MAX_ROWS);
    },
  );
});

describe('resolveBatchSize / resolveMaxBatches', () => {
  it('defaults match the event-loop-safe per-tick budget', () => {
    expect(resolveBatchSize({})).toBe(DEFAULT_BATCH_SIZE);
    expect(resolveMaxBatches({})).toBe(DEFAULT_MAX_BATCHES);
    expect(DEFAULT_BATCH_SIZE * DEFAULT_MAX_BATCHES).toBe(50_000);
  });

  it('clamps batch size into 100..5000', () => {
    expect(resolveBatchSize({ FINALIZE_RUNNER_JOB_LOG_REAP_BATCH_SIZE: '50' })).toBe(100);
    expect(resolveBatchSize({ FINALIZE_RUNNER_JOB_LOG_REAP_BATCH_SIZE: '9000' })).toBe(5_000);
    expect(resolveBatchSize({ FINALIZE_RUNNER_JOB_LOG_REAP_BATCH_SIZE: '1500' })).toBe(1_500);
  });

  it('clamps maxBatches into 1..50', () => {
    expect(resolveMaxBatches({ FINALIZE_RUNNER_JOB_LOG_REAP_MAX_BATCHES: '0' })).toBe(
      DEFAULT_MAX_BATCHES,
    );
    expect(resolveMaxBatches({ FINALIZE_RUNNER_JOB_LOG_REAP_MAX_BATCHES: '999' })).toBe(50);
    expect(resolveMaxBatches({ FINALIZE_RUNNER_JOB_LOG_REAP_MAX_BATCHES: '10' })).toBe(10);
  });
});

describe('resolveReaperCron', () => {
  it('defaults to every 5 minutes', () => {
    expect(resolveReaperCron({})).toBe(RUNNER_JOB_LOG_REAPER_CRON);
    expect(RUNNER_JOB_LOG_REAPER_CRON).toBe('*/5 * * * *');
  });

  it('honors a valid override', () => {
    expect(resolveReaperCron({ FINALIZE_RUNNER_JOB_LOG_REAPER_CRON: '*/10 * * * *' })).toBe(
      '*/10 * * * *',
    );
  });

  it.each(['', 'not a cron', '* * *', '60 * * * *'])(
    'falls back to the default for invalid expression %j',
    (raw) => {
      expect(resolveReaperCron({ FINALIZE_RUNNER_JOB_LOG_REAPER_CRON: raw })).toBe(
        RUNNER_JOB_LOG_REAPER_CRON,
      );
    },
  );
});

describe('runRunnerJobLogReaper (mocked)', () => {
  it('prunes expired frames first, then spends leftover budget on the size cap', () => {
    const pruneExpired = vi.fn().mockReturnValue(4);
    const pruneOldest = vi.fn().mockReturnValue(2);
    const result = runRunnerJobLogReaper({
      now: () => 1_000_000,
      retentionMs: 10_000,
      maxRows: 50,
      batchSize: 10,
      maxBatches: 3,
      pruneExpired,
      pruneOldest,
      log: () => {},
    });
    expect(result).toEqual({ expiredDeleted: 4, sizeDeleted: 2 });
    expect(pruneExpired).toHaveBeenCalledWith({ cutoff: 990_000, batchSize: 10, maxBatches: 3 });
    expect(pruneOldest).toHaveBeenCalledWith({
      keepRows: 50,
      batchSize: 10,
      maxBatches: 3,
      maxDeletes: 26,
    });
  });

  it('skips the size pass when the age pass spent the whole tick budget', () => {
    const pruneExpired = vi.fn().mockReturnValue(20);
    const pruneOldest = vi.fn();
    const result = runRunnerJobLogReaper({
      now: () => 0,
      retentionMs: 1,
      batchSize: 10,
      maxBatches: 2,
      pruneExpired,
      pruneOldest,
      log: () => {},
    });
    expect(result).toEqual({ expiredDeleted: 20, sizeDeleted: 0 });
    expect(pruneOldest).not.toHaveBeenCalled();
  });

  it('logs only when rows were actually pruned', () => {
    const log = vi.fn();
    runRunnerJobLogReaper({
      now: () => 0,
      retentionMs: 1,
      pruneExpired: () => 0,
      pruneOldest: () => 0,
      log,
    });
    expect(log).not.toHaveBeenCalled();
    runRunnerJobLogReaper({
      now: () => 0,
      retentionMs: 1,
      pruneExpired: () => 2,
      pruneOldest: () => 0,
      log,
    });
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('runRunnerJobLogReaper (orgs.db)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runner-job-log-reaper-'));
    dbPath = path.join(dir, 'orgs.db');
    setOrgsDbPathForTests(dbPath);
    initOrgsDb();
  });

  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const enq = () =>
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      specJson: '{}',
      now: 1000,
    });

  const seed = (jobId: string, n: number, at: number, data: string) => {
    const insert = getOrgsDb().prepare(
      'INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at) VALUES (?,?,?,?,?,?)',
    );
    const start = runnerJobLogStats().rows;
    getOrgsDb().transaction(() => {
      for (let i = 0; i < n; i++) insert.run(jobId, start + i, 0, 'stdout', data, at);
    })();
  };

  it('removes rows past the TTL and retains rows within it', () => {
    const j = enq();
    const now = 1_000_000;
    const retentionMs = 10_000;
    seed(j, 3, now - retentionMs - 1, 'expired');
    seed(j, 2, now - 1, 'fresh');

    const result = runRunnerJobLogReaper({
      now: () => now,
      retentionMs,
      maxRows: 10_000,
      batchSize: 10,
      maxBatches: 5,
      log: () => {},
    });

    expect(result.expiredDeleted).toBe(3);
    expect(result.sizeDeleted).toBe(0);
    expect(runnerJobLogStats().rows).toBe(2);
    const survivors = getOrgsDb().prepare('SELECT data FROM runner_job_logs').all() as Array<{
      data: string;
    }>;
    expect(survivors.every((r) => r.data === 'fresh')).toBe(true);
  });

  it('evicts oldest in-window rows when over the size cap', () => {
    const j = enq();
    const now = 1_000_000;
    for (let i = 0; i < 10; i++) seed(j, 1, now - 10 + i, `row-${i}`);

    const result = runRunnerJobLogReaper({
      now: () => now,
      retentionMs: 1_000,
      maxRows: 4,
      batchSize: 10,
      maxBatches: 5,
      log: () => {},
    });

    expect(result.expiredDeleted).toBe(0);
    expect(result.sizeDeleted).toBe(6);
    expect(runnerJobLogStats().rows).toBe(4);
    const survivors = getOrgsDb()
      .prepare('SELECT data FROM runner_job_logs ORDER BY at ASC')
      .all() as Array<{ data: string }>;
    expect(survivors.map((r) => r.data)).toEqual(['row-6', 'row-7', 'row-8', 'row-9']);
  });

  it('respects the per-tick batch bound across both passes', () => {
    const j = enq();
    const now = 1_000_000;
    seed(j, 15, now - 20_000, 'expired');
    seed(j, 10, now - 1, 'fresh');

    const result = runRunnerJobLogReaper({
      now: () => now,
      retentionMs: 10_000,
      maxRows: 3,
      batchSize: 5,
      maxBatches: 4,
      log: () => {},
    });

    // Budget 20. Age pass deletes all 15 expired. Size pass has 5 left and
    // needs to drop 7 fresh (10-3), so it spends the leftover 5.
    expect(result.expiredDeleted).toBe(15);
    expect(result.sizeDeleted).toBe(5);
    expect(result.expiredDeleted + result.sizeDeleted).toBe(20);
    expect(runnerJobLogStats().rows).toBe(5);
  });

  it('drops orgs.db / WAL footprint on a seeded flood after a batched reap', () => {
    const j = enq();
    const now = 10_000_000;
    const payload = 'x'.repeat(2048);
    const flood = 1_200;
    seed(j, flood, now - 60_000, payload);
    seed(j, 40, now - 100, 'fresh');

    // Materialize the flood into the main file so dbBytes is the honest before.
    getOrgsDb().pragma('wal_checkpoint(TRUNCATE)');
    const beforeStats = runnerJobLogStats();
    const beforeFiles = measureOrgsDb(dbPath);
    expect(beforeStats.rows).toBe(flood + 40);
    expect(beforeStats.payloadBytes).toBeGreaterThan(flood * 2000);
    expect(beforeFiles.dbBytes).toBeGreaterThan(flood * 2000);

    const result = runRunnerJobLogReaper({
      now: () => now,
      retentionMs: 10_000,
      maxRows: 10_000,
      batchSize: 200,
      maxBatches: 10,
      log: () => {},
    });

    // 1_200 expired, budget 2_000: whole flood goes in one tick; 40 fresh stay.
    expect(result.expiredDeleted).toBe(flood);
    expect(result.sizeDeleted).toBe(0);

    const afterStats = runnerJobLogStats();
    expect(afterStats.rows).toBe(40);
    expect(afterStats.payloadBytes).toBeLessThan(beforeStats.payloadBytes / 10);

    // Batched DELETEs land in the WAL; TRUNCATE checkpoints them. The main
    // file does not shrink without VACUUM (freelist reuse), and production
    // never VACUUMs on this path (that would itself stall).
    const midFiles = measureOrgsDb(dbPath);
    getOrgsDb().pragma('wal_checkpoint(TRUNCATE)');
    const afterFiles = measureOrgsDb(dbPath);

    console.log(
      `[runner-job-log-reaper] flood before rows=${beforeStats.rows} payload=${beforeStats.payloadBytes} db=${beforeFiles.dbBytes} wal=${beforeFiles.walBytes}`,
    );
    console.log(
      `[runner-job-log-reaper] flood after  rows=${afterStats.rows} payload=${afterStats.payloadBytes} db=${afterFiles.dbBytes} wal=${afterFiles.walBytes} walDuringReap=${midFiles.walBytes} expired=${result.expiredDeleted}`,
    );

    expect(afterFiles.walBytes).toBeLessThan(64 * 1024);
    expect(afterStats.payloadBytes).toBeLessThan(beforeStats.payloadBytes);
  });
});
