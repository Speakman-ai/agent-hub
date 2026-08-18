/**
 * Parity test for the cron → job-queue migration.
 *
 * Proves the core behaviour change: with the (default-on) `scheduledJobsViaQueue`
 * flag, a scheduler tick ENQUEUES a job instead of running the work inline; with
 * the flag off, the dispatch helpers route around the queue (legacy path).
 *
 * Isolation: the scheduled-jobs singleton is initialised against a dedicated
 * in-memory database owned by this test, NOT heartbeat.ts's shared app `db`.
 * That keeps the started worker loop (timers, claim/reap writes) off the shared
 * per-process test DB file, so nothing can leak into other test files. The
 * `dispatch*` enqueue path talks only to the scheduled-jobs singleton, so it
 * never needs the real app db.
 *
 * child_process is mocked before importing heartbeat.js so the module's
 * transitive spawn/execFile paths are inert (per server/test/setup.ts rules —
 * never spawn a real CLI). The queue handlers here are no-ops; handler
 * execution is covered by jobs/scheduled-jobs.test.ts.
 */
import Database from 'better-sqlite3';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { JOBS_SCHEMA } from './jobs/schema.js';

vi.mock('child_process', () => {
  const noop = vi.fn(
    (
      _file: unknown,
      _args: unknown,
      _opts: unknown,
      cb?: (err: Error | null, value: { stdout: string; stderr: string }) => void,
    ) => {
      if (typeof cb === 'function') cb(null, { stdout: '', stderr: '' });
    },
  );
  return { spawn: vi.fn(), execFile: noop, exec: noop };
});

const { default: config } = await import('./config.js');
const { dispatchCron, ensureScheduledJobQueue } = await import('./heartbeat.js');
const { initScheduledJobQueue, getScheduledJobQueue, shutdownScheduledJobQueue, CRON_JOB_TYPE } =
  await import('./jobs/scheduled-jobs.js');

const origFlag = config.scheduledJobsViaQueue;
let db: Database.Database;

/** Point the scheduled-jobs singleton at this test's isolated in-memory db. */
function initIsolatedQueue() {
  return initScheduledJobQueue({
    db,
    log: () => {},
    heartbeatHandler: async () => {},
    cronHandler: async () => {},
  });
}

function jobRows(): Array<{ type: string; payload: string }> {
  return db.prepare('SELECT type, payload FROM jobs').all() as Array<{
    type: string;
    payload: string;
  }>;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(JOBS_SCHEMA);
  config.scheduledJobsViaQueue = true;
});

afterEach(async () => {
  // Stop + await the worker BEFORE closing the db so no timer writes post-close.
  await shutdownScheduledJobQueue();
  db.close();
  config.scheduledJobsViaQueue = origFlag;
});

describe('scheduled dispatch', () => {
  it('queue mode: enqueues a cron job with the numeric cronId', () => {
    initIsolatedQueue();

    dispatchCron(123);

    const cr = jobRows().find((r) => r.type === CRON_JOB_TYPE);
    expect(cr).toBeTruthy();
    expect(JSON.parse(cr!.payload)).toEqual({ cronId: 123 });
  });

  it('flag off: routes around the queue even when one exists (legacy inline path)', () => {
    initIsolatedQueue();
    config.scheduledJobsViaQueue = false;

    const before = jobRows().length;
    // Legacy dispatchCron re-reads the row; an unknown cron id runs nothing and
    // — crucially — enqueues nothing, proving the flag gates the queue branch.
    dispatchCron(999);
    expect(jobRows().length).toBe(before);
  });

  it('flag off: ensureScheduledJobQueue builds no queue (legacy path stays available)', () => {
    config.scheduledJobsViaQueue = false;
    ensureScheduledJobQueue();
    expect(getScheduledJobQueue()).toBeNull();
  });
});
