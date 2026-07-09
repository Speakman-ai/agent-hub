/**
 * In-house background job queue on SQLite (better-sqlite3, WAL).
 *
 * See `schema.ts` for the table and the locked `job-queue` epic decision.
 *
 * Design notes:
 *   - Claiming is a single atomic statement. SQLite serializes writers, so two
 *     concurrent claims can never pick the same row — the second sees the row
 *     already `running` and skips it. No `SELECT FOR UPDATE`, no app-level lock.
 *   - Attempts are incremented at claim time (not at settle) so a worker that
 *     dies mid-flight still burns an attempt; the reaper then applies the same
 *     retry/dead-letter rule as a normal failure and can never loop forever.
 *   - Every claim mints a fresh `lease_id`. All settle statements guard on it,
 *     so a zombie handler that outlived the reaper (its row already reclaimed
 *     and possibly re-run by another worker) cannot clobber the newer claim:
 *     its stale lease no longer matches and the settle UPDATE is a no-op.
 *     Execution is therefore at-least-once, and the current lease owner's
 *     outcome always wins — no silent double-write / lost update.
 *   - Handlers are registered by job type. An enqueued job with no registered
 *     handler is released back to `queued` with its claim attempt REFUNDED
 *     (a missing handler is not the job's fault — it may register later / after
 *     a restart), deferred by `unhandledRetryDelayMs` so it doesn't churn a
 *     claim slot every poll.
 *   - The worker loop is timer-driven and honours a concurrency cap. Graceful
 *     shutdown stops claiming and awaits in-flight handlers; nothing is force
 *     killed, so a running transaction is never torn mid-statement.
 */
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { backoffDelayMs, type BackoffOptions } from './backoff.js';

export type JobStatus = 'queued' | 'running' | 'done' | 'dead_letter';

export interface JobRow {
  id: string;
  type: string;
  payload: string;
  status: JobStatus;
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: number;
  claimed_by: string | null;
  claimed_at: number | null;
  lease_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** A claimed job handed to a handler — payload decoded from JSON. */
export interface Job<P = unknown> {
  id: string;
  type: string;
  payload: P;
  priority: number;
  attempts: number;
  maxAttempts: number;
  runAt: number;
  createdAt: number;
}

export type JobHandler<P = unknown> = (job: Job<P>) => Promise<void> | void;

export interface EnqueueOptions {
  /** Lower value runs first. Default 0. */
  priority?: number;
  /** Max attempts before dead-letter. Default 5. */
  maxAttempts?: number;
  /** Delay before the job becomes eligible, in ms. Default 0 (immediate). */
  delayMs?: number;
}

export interface JobQueueOptions {
  db: BetterSqlite3.Database;
  /** Max handlers running at once. Default 1. */
  concurrency?: number;
  /** How often the worker loop polls for eligible jobs, in ms. Default 500. */
  pollIntervalMs?: number;
  /** A running job is considered stuck after this long, in ms. Default 60000. */
  stuckTimeoutMs?: number;
  /** How often the reaper scans for stuck jobs, in ms. Default stuckTimeoutMs/2. */
  reaperIntervalMs?: number;
  /**
   * How long to defer re-claiming a job whose type has no registered handler,
   * in ms. The attempt is refunded (not charged), so this only spaces out the
   * re-checks instead of churning a claim slot every poll. Default 30000.
   */
  unhandledRetryDelayMs?: number;
  /** Retry backoff schedule. */
  backoff?: BackoffOptions;
  /** This worker's identity, written to `claimed_by`. Default a random id. */
  workerId?: string;
  /** Clock; injected for deterministic tests. Default Date.now. */
  now?: () => number;
  /** Log sink for handler errors and reaper actions. Default console.warn. */
  log?: (msg: string) => void;
}

interface Statements {
  insert: BetterSqlite3.Statement;
  claim: BetterSqlite3.Statement;
  markDone: BetterSqlite3.Statement;
  retry: BetterSqlite3.Statement;
  deadLetter: BetterSqlite3.Statement;
  releaseUnhandled: BetterSqlite3.Statement;
  reapStuck: BetterSqlite3.Statement;
  getById: BetterSqlite3.Statement;
}

function decodePayload(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    type: row.type,
    payload: decodePayload(row.payload),
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    runAt: row.run_at,
    createdAt: row.created_at,
  };
}

export class JobQueue {
  private readonly db: BetterSqlite3.Database;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly stuckTimeoutMs: number;
  private readonly reaperIntervalMs: number;
  private readonly unhandledRetryDelayMs: number;
  private readonly backoff: BackoffOptions;
  private readonly workerId: string;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly stmts: Statements;
  private readonly handlers = new Map<string, JobHandler>();

  private running = false;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  /** In-flight handler promises, tracked so shutdown can await them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(opts: JobQueueOptions) {
    this.db = opts.db;
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
    this.pollIntervalMs = opts.pollIntervalMs ?? 500;
    this.stuckTimeoutMs = opts.stuckTimeoutMs ?? 60_000;
    this.reaperIntervalMs =
      opts.reaperIntervalMs ?? Math.max(1000, Math.floor(this.stuckTimeoutMs / 2));
    this.unhandledRetryDelayMs = Math.max(0, opts.unhandledRetryDelayMs ?? 30_000);
    this.backoff = opts.backoff ?? {};
    this.workerId = opts.workerId ?? `worker-${randomUUID()}`;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((msg) => console.warn(msg));
    this.stmts = this.prepare();
  }

  private prepare(): Statements {
    return {
      insert: this.db.prepare(
        `INSERT INTO jobs (id, type, payload, status, priority, attempts, max_attempts, run_at, created_at, updated_at)
         VALUES (@id, @type, @payload, 'queued', @priority, 0, @maxAttempts, @runAt, @now, @now)`,
      ),
      // Atomic claim: mint a fresh lease, increment attempts, and flip to
      // running in one statement. The subquery picks the highest-priority
      // eligible job (FIFO tie-break); SQLite's single writer guarantees no
      // two workers claim the same row.
      claim: this.db.prepare(
        `UPDATE jobs
           SET status = 'running',
               claimed_by = @workerId,
               claimed_at = @now,
               lease_id = @leaseId,
               attempts = attempts + 1,
               updated_at = @now
         WHERE id = (
           SELECT id FROM jobs
            WHERE status = 'queued' AND run_at <= @now
            ORDER BY priority ASC, created_at ASC
            LIMIT 1
         )
         RETURNING *`,
      ),
      // Every settle statement is scoped to the claim's lease AND status =
      // 'running'. If the reaper reclaimed the row (clearing/replacing the
      // lease) while this worker's handler was still running, the guard fails
      // to match and the UPDATE is a no-op — the newer claim's state stands.
      markDone: this.db.prepare(
        `UPDATE jobs SET status = 'done', claimed_by = NULL, claimed_at = NULL, lease_id = NULL,
               last_error = NULL, updated_at = @now
         WHERE id = @id AND lease_id = @leaseId AND status = 'running'`,
      ),
      retry: this.db.prepare(
        `UPDATE jobs
           SET status = 'queued', run_at = @runAt, last_error = @error,
               claimed_by = NULL, claimed_at = NULL, lease_id = NULL, updated_at = @now
         WHERE id = @id AND lease_id = @leaseId AND status = 'running'`,
      ),
      deadLetter: this.db.prepare(
        `UPDATE jobs SET status = 'dead_letter', claimed_by = NULL, claimed_at = NULL, lease_id = NULL,
               last_error = @error, updated_at = @now
         WHERE id = @id AND lease_id = @leaseId AND status = 'running'`,
      ),
      // No-handler release: refund the attempt the claim charged (a missing
      // handler is not the job's fault) and defer the next re-claim. Same
      // lease/status guard so a raced reap can't be undone.
      releaseUnhandled: this.db.prepare(
        `UPDATE jobs
           SET status = 'queued', run_at = @runAt, last_error = @error,
               attempts = attempts - 1,
               claimed_by = NULL, claimed_at = NULL, lease_id = NULL, updated_at = @now
         WHERE id = @id AND lease_id = @leaseId AND status = 'running'`,
      ),
      // Reclaim rows whose worker died: still 'running' but claimed before the
      // cutoff. RETURNING lets us apply retry/dead-letter per row in JS.
      reapStuck: this.db.prepare(
        `SELECT * FROM jobs WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at <= @cutoff`,
      ),
      getById: this.db.prepare(`SELECT * FROM jobs WHERE id = @id`),
    };
  }

  /** Register a handler for a job type. Replaces any prior handler. */
  register<P = unknown>(type: string, handler: JobHandler<P>): void {
    this.handlers.set(type, handler as JobHandler);
  }

  /** Enqueue a job. Returns the new job id. */
  enqueue(type: string, payload: unknown = {}, opts: EnqueueOptions = {}): string {
    const id = randomUUID();
    const now = this.now();
    this.stmts.insert.run({
      id,
      type,
      payload: JSON.stringify(payload ?? {}),
      priority: opts.priority ?? 0,
      maxAttempts: opts.maxAttempts ?? 5,
      runAt: now + Math.max(0, opts.delayMs ?? 0),
      now,
    });
    return id;
  }

  /** Fetch a raw job row by id (inspection / tests). */
  getJob(id: string): JobRow | undefined {
    return this.stmts.getById.get({ id }) as JobRow | undefined;
  }

  /**
   * Atomically claim the next eligible job, or return undefined if none.
   * Public so a race test can hammer it from N callers against one db.
   */
  claim(): JobRow | undefined {
    return this.stmts.claim.get({
      workerId: this.workerId,
      leaseId: randomUUID(),
      now: this.now(),
    }) as JobRow | undefined;
  }

  /**
   * Run a claimed job's handler and settle it (done / retry / dead-letter).
   * Exposed so tests can drive a single job without the timer loop.
   *
   * `row.lease_id` scopes the settle: if the reaper reclaimed the job while the
   * handler ran, the settle no-ops and the newer claim's state is preserved.
   */
  async process(row: JobRow): Promise<void> {
    const handler = this.handlers.get(row.type);
    if (!handler) {
      // No handler yet (may register later / after a restart). Release back to
      // queued, refunding the attempt the claim charged, and defer the next
      // re-claim so an unhandled type doesn't churn a slot on every poll.
      this.stmts.releaseUnhandled.run({
        id: row.id,
        leaseId: row.lease_id,
        runAt: this.now() + this.unhandledRetryDelayMs,
        error: `no handler registered for type '${row.type}'`,
        now: this.now(),
      });
      return;
    }
    try {
      await handler(toJob(row));
      const info = this.stmts.markDone.run({
        id: row.id,
        leaseId: row.lease_id,
        now: this.now(),
      });
      if (info.changes === 0) {
        // Lease no longer current: the job was reaped mid-flight and likely
        // re-run by another worker. This completion is discarded (at-least-once).
        this.log(
          `[job-queue] job ${row.id} (${row.type}) completed on a stale lease ${row.lease_id}; ` +
            `discarding (reclaimed by the reaper while running)`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.fail(row, message);
    }
  }

  /**
   * Apply the retry-or-dead-letter rule for a failed/abandoned job. All writes
   * are lease-scoped, so a settle that lost the race to the reaper no-ops.
   */
  private fail(row: JobRow, error: string): void {
    if (row.attempts >= row.max_attempts) {
      this.stmts.deadLetter.run({
        id: row.id,
        leaseId: row.lease_id,
        error,
        now: this.now(),
      });
      this.log(
        `[job-queue] job ${row.id} (${row.type}) dead-lettered after ${row.attempts} attempts: ${error}`,
      );
      return;
    }
    this.releaseForRetry(row, error);
  }

  private releaseForRetry(row: JobRow, error: string): void {
    const delay = backoffDelayMs(row.attempts, this.backoff);
    this.stmts.retry.run({
      id: row.id,
      leaseId: row.lease_id,
      runAt: this.now() + delay,
      error,
      now: this.now(),
    });
  }

  /**
   * Reclaim jobs whose claimant died (running past the stuck timeout). Applies
   * the same retry/dead-letter rule as a handler failure. Returns the count
   * reaped. Public so tests can trigger it deterministically.
   */
  reap(): number {
    const cutoff = this.now() - this.stuckTimeoutMs;
    const stuck = this.stmts.reapStuck.all({ cutoff }) as JobRow[];
    for (const row of stuck) {
      this.fail(
        row,
        `reaped: worker '${row.claimed_by}' did not finish within ${this.stuckTimeoutMs}ms`,
      );
    }
    if (stuck.length > 0) {
      this.log(`[job-queue] reaped ${stuck.length} stuck job(s)`);
    }
    return stuck.length;
  }

  /** Start the worker loop and the stuck-job reaper. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleTick(0);
    this.reaperTimer = setInterval(() => {
      try {
        this.reap();
      } catch (err) {
        this.log(`[job-queue] reaper error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, this.reaperIntervalMs);
    // Don't keep the process alive purely for the reaper.
    this.reaperTimer.unref?.();
  }

  private scheduleTick(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  /**
   * One poll iteration: claim up to the free-slot count and dispatch each.
   * Reschedules itself. Returns the number of jobs dispatched this tick.
   */
  async tick(): Promise<number> {
    if (!this.running) return 0;
    let dispatched = 0;
    while (this.inFlight.size < this.concurrency) {
      let row: JobRow | undefined;
      try {
        row = this.claim();
      } catch (err) {
        this.log(`[job-queue] claim error: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      if (!row) break;
      dispatched++;
      const p = this.process(row)
        .catch((err) => {
          // process() already handles handler errors; this guards against a
          // bug in the settle path itself so a slot is always freed.
          this.log(
            `[job-queue] settle error for job ${row?.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        })
        .finally(() => {
          this.inFlight.delete(p);
        });
      this.inFlight.add(p);
    }
    // Poll again sooner when we're saturated or found work; back off when idle.
    this.scheduleTick(dispatched > 0 ? 0 : this.pollIntervalMs);
    return dispatched;
  }

  /**
   * Stop claiming new work and await all in-flight handlers. In-flight jobs
   * finish normally (or settle via their own error path); nothing is killed.
   * Idempotent.
   */
  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
    await Promise.allSettled([...this.inFlight]);
  }

  /** Count of handlers currently executing. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }
}
