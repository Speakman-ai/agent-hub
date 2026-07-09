/**
 * Admin/observability helpers for the in-house SQLite job queue.
 *
 * These are pure read/mutate functions over the `jobs` table (see
 * `schema.ts`), kept separate from `JobQueue` (the worker runtime) so the
 * REST admin surface can inspect and hand-manage jobs without owning a
 * running queue instance. The route layer passes the shared app db handle.
 *
 * Retry semantics: only a `dead_letter` job can be retried. Retrying resets
 * it to `queued` with a fresh attempt budget (attempts = 0), clears the
 * recorded error and any stale claim fields, and makes it eligible now
 * (run_at = now) so the next worker poll picks it up. A job in any other
 * state is left untouched (the caller surfaces a 409).
 */
import type BetterSqlite3 from 'better-sqlite3';
import type { JobRow, JobStatus } from './job-queue.js';

export const JOB_STATUSES: readonly JobStatus[] = ['queued', 'running', 'done', 'dead_letter'];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

export interface ListJobsFilter {
  status?: JobStatus;
  type?: string;
  /** Max rows returned. Clamped by the caller; default 50 here. */
  limit?: number;
  /** Rows to skip (simple offset pagination). Default 0. */
  offset?: number;
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  dead_letter: number;
  total: number;
}

/**
 * List jobs newest-first, optionally filtered by status and/or exact type.
 * The status/type predicates use the `(? IS NULL OR col = ?)` idiom so a
 * single prepared shape covers every filter combination.
 */
export function listJobs(db: BetterSqlite3.Database, filter: ListJobsFilter = {}): JobRow[] {
  const limit = Math.max(1, Math.min(200, filter.limit ?? 50));
  const offset = Math.max(0, filter.offset ?? 0);
  const status = filter.status ?? null;
  const type = filter.type ?? null;
  return db
    .prepare(
      `SELECT * FROM jobs
        WHERE (@status IS NULL OR status = @status)
          AND (@type IS NULL OR type = @type)
        ORDER BY created_at DESC, id DESC
        LIMIT @limit OFFSET @offset`,
    )
    .all({ status, type, limit, offset }) as JobRow[];
}

/**
 * Count jobs per status (for the observability summary cards). These totals
 * are always host-wide and UNFILTERED — by design they show the whole queue
 * at a glance and are independent of the list's status/type filter, so the
 * summary cards and the visible (filtered) rows can legitimately disagree.
 */
export function countJobsByStatus(db: BetterSqlite3.Database): JobCounts {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM jobs GROUP BY status`).all() as Array<{
    status: JobStatus;
    n: number;
  }>;
  const counts: JobCounts = { queued: 0, running: 0, done: 0, dead_letter: 0, total: 0 };
  for (const row of rows) {
    if (isJobStatus(row.status)) {
      counts[row.status] = row.n;
      counts.total += row.n;
    }
  }
  return counts;
}

/** The distinct job types present in the table, sorted, for filter menus. */
export function listJobTypes(db: BetterSqlite3.Database): string[] {
  const rows = db.prepare(`SELECT DISTINCT type FROM jobs ORDER BY type ASC`).all() as Array<{
    type: string;
  }>;
  return rows.map((r) => r.type);
}

export function getJobRow(db: BetterSqlite3.Database, id: string): JobRow | undefined {
  return db.prepare(`SELECT * FROM jobs WHERE id = @id`).get({ id }) as JobRow | undefined;
}

export type RetryResult = 'retried' | 'not_found' | 'not_dead_letter';

/**
 * Requeue a dead-lettered job: reset to `queued`, refresh the attempt budget,
 * clear the error and any lingering claim fields, and make it eligible now.
 * Guarded on `status = 'dead_letter'` so a concurrent claim can't be undone.
 */
export function retryDeadLetterJob(
  db: BetterSqlite3.Database,
  id: string,
  now: number = Date.now(),
): RetryResult {
  const row = getJobRow(db, id);
  if (!row) return 'not_found';
  if (row.status !== 'dead_letter') return 'not_dead_letter';
  const info = db
    .prepare(
      `UPDATE jobs
         SET status = 'queued', attempts = 0, run_at = @now, last_error = NULL,
             claimed_by = NULL, claimed_at = NULL, lease_id = NULL, updated_at = @now
       WHERE id = @id AND status = 'dead_letter'`,
    )
    .run({ id, now });
  // The row could have flipped out of dead_letter between the read and the
  // write (extremely unlikely — nothing re-runs a dead job automatically —
  // but the guard keeps it honest). Treat a no-op UPDATE as a lost race.
  return info.changes > 0 ? 'retried' : 'not_dead_letter';
}

/** Delete a job by id. Returns true if a row was removed. */
export function deleteJob(db: BetterSqlite3.Database, id: string): boolean {
  const info = db.prepare(`DELETE FROM jobs WHERE id = @id`).run({ id });
  return info.changes > 0;
}
