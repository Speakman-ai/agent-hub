/**
 * Tests for the scheduled-work queue wrapper (heartbeats + crons).
 *
 * Runs against a real in-memory better-sqlite3 so the jobs schema, enqueue,
 * and worker loop are exercised end-to-end. Handlers here are plain spies —
 * the heavy runHeartbeat / runCronJob live in heartbeat.ts and are covered by
 * the heartbeat-dispatch test, which mocks the CLI wrapper per
 * server/test/setup.ts. Nothing here spawns a real CLI.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JOBS_SCHEMA } from './schema.js';
import {
  initScheduledJobQueue,
  getScheduledJobQueue,
  enqueueHeartbeatJob,
  enqueueCronJob,
  shutdownScheduledJobQueue,
  HEARTBEAT_JOB_TYPE,
  CRON_JOB_TYPE,
  type HeartbeatJobPayload,
  type CronJobPayload,
} from './scheduled-jobs.js';

let db: Database.Database;
const silent = () => {};

/** Drain the queue by ticking until nothing is claimed and nothing is in flight. */
async function drain(): Promise<void> {
  const q = getScheduledJobQueue();
  if (!q) return;
  for (let i = 0; i < 50; i++) {
    const dispatched = await q.tick();
    // Wait a microtask for in-flight handlers to settle before re-checking.
    await Promise.resolve();
    if (dispatched === 0 && q.inFlightCount === 0) return;
    await new Promise((r) => setImmediate(r));
  }
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(JOBS_SCHEMA);
});

afterEach(async () => {
  await shutdownScheduledJobQueue();
  db.close();
});

describe('scheduled job queue', () => {
  it('runs the heartbeat handler with the enqueued agentId', async () => {
    const seen: HeartbeatJobPayload[] = [];
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async (job) => {
        seen.push(job.payload);
      },
      cronHandler: async () => {},
    });

    const jobId = enqueueHeartbeatJob('agent-1');
    expect(jobId).toBeTruthy();
    await drain();

    expect(seen).toEqual([{ agentId: 'agent-1' }]);
    expect(getScheduledJobQueue()!.getJob(jobId!)?.status).toBe('done');
  });

  it('runs the cron handler with the enqueued numeric cronId', async () => {
    const seen: CronJobPayload[] = [];
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {},
      cronHandler: async (job) => {
        seen.push(job.payload);
      },
    });

    const jobId = enqueueCronJob(42);
    await drain();

    expect(seen).toEqual([{ cronId: 42 }]);
    expect(getScheduledJobQueue()!.getJob(jobId!)?.status).toBe('done');
  });

  it('enqueues under the documented job type discriminators', () => {
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {},
      cronHandler: async () => {},
    });
    const hb = enqueueHeartbeatJob('a');
    const cr = enqueueCronJob(7);
    const q = getScheduledJobQueue()!;
    expect(q.getJob(hb!)?.type).toBe(HEARTBEAT_JOB_TYPE);
    expect(q.getJob(cr!)?.type).toBe(CRON_JOB_TYPE);
  });

  it('does NOT retry a failing run — maxAttempts=1 dead-letters immediately (next tick is the retry)', async () => {
    let calls = 0;
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {
        calls++;
        throw new Error('boom');
      },
      cronHandler: async () => {},
    });

    const jobId = enqueueHeartbeatJob('agent-x');
    await drain();

    // Exactly one execution — no queue-level backoff/retry.
    expect(calls).toBe(1);
    const row = getScheduledJobQueue()!.getJob(jobId!);
    expect(row?.status).toBe('dead_letter');
    expect(row?.attempts).toBe(1);
    expect(row?.max_attempts).toBe(1);
  });

  it('a reaped (crashed) scheduled job dead-letters and is never re-run', () => {
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {},
      cronHandler: async () => {},
    });
    const q = getScheduledJobQueue()!;
    const jobId = enqueueHeartbeatJob('agent-crash');

    // Simulate a worker that claimed the job then died: claim it, then
    // backdate claimed_at well past the stuck timeout so the reaper fires.
    const claimed = q.claim();
    expect(claimed?.id).toBe(jobId);
    db.prepare('UPDATE jobs SET claimed_at = 1 WHERE id = ?').run(jobId);

    const reaped = q.reap();
    expect(reaped).toBe(1);
    const row = q.getJob(jobId!);
    // attempts already hit max_attempts (1) at claim time → dead_letter, not requeued.
    expect(row?.status).toBe('dead_letter');
  });

  it('enqueue helpers return null when the queue is not initialised', () => {
    expect(getScheduledJobQueue()).toBeNull();
    expect(enqueueHeartbeatJob('a')).toBeNull();
    expect(enqueueCronJob(1)).toBeNull();
  });

  it('initScheduledJobQueue is idempotent and re-registers handlers', async () => {
    const first = initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {},
      cronHandler: async () => {},
    });
    let ran = false;
    const second = initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {
        ran = true;
      },
      cronHandler: async () => {},
    });
    expect(second).toBe(first); // same singleton instance

    enqueueHeartbeatJob('a');
    await drain();
    expect(ran).toBe(true); // latest handler won
  });

  it('shutdown drops the singleton so a later init builds fresh', async () => {
    initScheduledJobQueue({
      db,
      log: silent,
      heartbeatHandler: async () => {},
      cronHandler: async () => {},
    });
    expect(getScheduledJobQueue()).not.toBeNull();
    await shutdownScheduledJobQueue();
    expect(getScheduledJobQueue()).toBeNull();
  });
});
