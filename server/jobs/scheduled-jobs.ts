/**
 * Scheduled-work consumer of the in-house SQLite job queue.
 *
 * Per-agent heartbeats and project crons, the two producers this queue was
 * built for, are both gone. `scheduled.heartbeat` and `scheduled.cron` stay
 * recognized job types so leftover rows from an older process drain as
 * no-ops; nothing enqueues new ones.
 *
 * A config flag (`scheduledJobsViaQueue`, default on) controls whether the
 * queue is started at all; the helper that consults it lives in
 * `heartbeat.ts`.
 */
import type BetterSqlite3 from 'better-sqlite3';
import { JobQueue, type JobHandler } from './job-queue.js';

/** Job `type` discriminators written to the `jobs` table. */
export const HEARTBEAT_JOB_TYPE = 'scheduled.heartbeat';
export const CRON_JOB_TYPE = 'scheduled.cron';

/** Default concurrency when the caller doesn't override it. */
export const DEFAULT_SCHEDULED_CONCURRENCY = 10;

/**
 * Stuck-job timeout for scheduled work. Well above any realistic heartbeat /
 * cron runtime (CLI timeouts run to many minutes) so the reaper only fires on
 * a genuinely crashed process. Combined with `maxAttempts = 1`, a reaped job
 * is dead-lettered — never re-run.
 *
 * Assumption: a single scheduled run finishes within 1h. A pathological run
 * that exceeds it would be reaped and dead-lettered while its handler promise
 * is still in flight — the DB row flips to dead_letter but the work itself
 * keeps running to completion (nothing kills it) and still writes its own
 * heartbeat_log / cron thread. So the only effect is a cosmetic dead_letter
 * row for a run that actually finished; `maxAttempts = 1` still guarantees no
 * duplicate execution. Raise this if a deployment routinely runs longer jobs.
 */
export const SCHEDULED_STUCK_TIMEOUT_MS = 60 * 60 * 1000; // 1h

export interface HeartbeatJobPayload {
  agentId: string;
}

export interface CronJobPayload {
  /** Numeric `crons.id` of a leftover job (not the queue's own job id). */
  cronId: number;
}

export interface ScheduledJobQueueOptions {
  db: BetterSqlite3.Database;
  heartbeatHandler: JobHandler<HeartbeatJobPayload>;
  cronHandler: JobHandler<CronJobPayload>;
  /** Max handlers running at once. Default {@link DEFAULT_SCHEDULED_CONCURRENCY}. */
  concurrency?: number;
  /** Clock; injected for deterministic tests. */
  now?: () => number;
  /** Log sink; defaults to the queue's own console.warn. */
  log?: (msg: string) => void;
}

let queue: JobQueue | null = null;

/**
 * Lazily construct and start the scheduled-work queue. Idempotent: the first
 * call builds the queue, later calls return the same instance but always
 * re-register the handlers (so a re-init after a config reload picks up fresh
 * closures) and re-`start()` (a no-op if already running).
 */
export function initScheduledJobQueue(opts: ScheduledJobQueueOptions): JobQueue {
  if (!queue) {
    queue = new JobQueue({
      db: opts.db,
      concurrency: Math.max(1, opts.concurrency ?? DEFAULT_SCHEDULED_CONCURRENCY),
      stuckTimeoutMs: SCHEDULED_STUCK_TIMEOUT_MS,
      now: opts.now,
      log: opts.log,
    });
  }
  queue.register(HEARTBEAT_JOB_TYPE, opts.heartbeatHandler as JobHandler);
  queue.register(CRON_JOB_TYPE, opts.cronHandler as JobHandler);
  queue.start();
  return queue;
}

/** The live scheduled-work queue, or null before {@link initScheduledJobQueue}. */
export function getScheduledJobQueue(): JobQueue | null {
  return queue;
}

/**
 * Enqueue a leftover heartbeat job. New heartbeats are not scheduled; this
 * stays so an in-flight `scheduled.heartbeat` row from an older process can
 * still drain (the registered handler is a no-op). Returns the job id, or
 * null if the queue is not initialised.
 */
export function enqueueHeartbeatJob(agentId: string): string | null {
  if (!queue) return null;
  const payload: HeartbeatJobPayload = { agentId };
  return queue.enqueue(HEARTBEAT_JOB_TYPE, payload, { maxAttempts: 1 });
}

/**
 * Stop claiming new work, await in-flight handlers, and drop the singleton.
 * For graceful shutdown and test isolation.
 */
export async function shutdownScheduledJobQueue(): Promise<void> {
  if (!queue) return;
  const q = queue;
  queue = null;
  await q.shutdown();
}
