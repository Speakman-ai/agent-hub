/**
 * Scheduled-work consumer of the in-house SQLite job queue.
 *
 * Heartbeats and crons no longer execute inline in their node-cron timer
 * callbacks. Instead each tick ENQUEUES a job here and a single worker loop
 * drains the queue. node-cron still decides WHEN work fires (timezone,
 * interval, missed-run accounting all unchanged); the queue owns HOW it runs.
 *
 * Parity guarantees (why the migration is invisible to users):
 *   - Jobs are enqueued with `maxAttempts = 1`, so the queue never retries a
 *     failed run — the next scheduled tick IS the retry, exactly as before.
 *     This also means the stuck-job reaper can only ever dead-letter a crashed
 *     job, never re-run it, so there is no risk of a duplicate heartbeat/cron
 *     execution.
 *   - `runHeartbeat` / `runCronJob` still write heartbeat_logs, cron threads,
 *     and next-run bookkeeping themselves, so user-visible history is identical
 *     whether a run executes inline (legacy) or via a queue worker.
 *   - `runHeartbeat` keeps its own in-flight guard. The queue concurrency cap
 *     bounds how many scheduled runs execute at once — it does not change WHAT
 *     each run records, but note it is a single shared budget across heartbeats
 *     AND crons, so under heavy contention (e.g. many slow crons in flight) a
 *     due run can be delayed until a slot frees. Legacy node-cron ran each on
 *     its own timer with unbounded total concurrency; the cap is the one
 *     intentional load-shaping change, tunable via `scheduledJobsConcurrency`.
 *
 * A config flag (`scheduledJobsViaQueue`, default on) lets an operator fall
 * back to the legacy direct-execution path for one release; the dispatch
 * helpers that consult it live in `heartbeat.ts`.
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
  /** Numeric `crons.id` primary key (not the queue's own job id). */
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
 * Enqueue a heartbeat run. `maxAttempts = 1`: no queue-level retry — the next
 * scheduled tick is the retry. Returns the job id, or null if the queue is not
 * initialised (caller should fall back to inline execution).
 */
export function enqueueHeartbeatJob(agentId: string): string | null {
  if (!queue) return null;
  const payload: HeartbeatJobPayload = { agentId };
  return queue.enqueue(HEARTBEAT_JOB_TYPE, payload, { maxAttempts: 1 });
}

/**
 * Enqueue a cron run. `maxAttempts = 1` for the same reason as heartbeats.
 * Returns the job id, or null if the queue is not initialised.
 */
export function enqueueCronJob(cronId: number): string | null {
  if (!queue) return null;
  const payload: CronJobPayload = { cronId };
  return queue.enqueue(CRON_JOB_TYPE, payload, { maxAttempts: 1 });
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
