/**
 * SQLite DDL for the in-house background job queue.
 *
 * Per the locked `job-queue` epic decision: a minimal jobs table on SQLite,
 * no external queue dependency (Redis / BullMQ rejected — they break the
 * zero-dependency drop-on-a-laptop install story). Claiming is a single
 * atomic `UPDATE ... WHERE id = (SELECT ... LIMIT 1)`, which is race-free
 * under SQLite's single-writer model on one node (no `SELECT FOR UPDATE`
 * needed). Heartbeats, crons, and future autonomous background tasks become
 * consumers of this queue.
 *
 * Status lifecycle (the only four states written):
 *   queued  → running        (claimed by a worker; attempts incremented)
 *   running → done           (handler resolved)
 *   running → queued         (handler rejected, attempts < max → retry w/ backoff)
 *   running → dead_letter    (handler rejected, attempts >= max)
 *   running → queued|dead_letter (reaper: claimant died, same retry rule)
 *
 * Columns:
 *   - `priority` — lower value runs first (ASC), matching the epic's claim
 *     SQL `ORDER BY priority, created_at`. Default 0.
 *   - `run_at` — unix millis; a job is eligible only when `run_at <= now`.
 *     Backoff pushes this into the future on retry; enqueue-with-delay uses
 *     it too.
 *   - `attempts` — incremented at claim time, so a job whose worker dies
 *     mid-flight still counts the attempt (the reaper won't loop forever).
 *     The no-handler path refunds the attempt (see JobQueue.process).
 *   - `claimed_by` / `claimed_at` — worker identity + claim timestamp; the
 *     reaper reclaims rows whose `claimed_at` is older than the stuck timeout.
 *   - `lease_id` — a fresh token minted on every claim. Settle statements
 *     (done/retry/dead-letter/release) guard on it so a zombie handler that
 *     outlived the reaper cannot clobber a newer claim's state — its stale
 *     lease no longer matches and the UPDATE affects zero rows. This is what
 *     makes execution at-least-once with a last-writer-is-the-current-owner
 *     guarantee rather than a silent lost-update.
 *   - timestamps are unix millis (server clock) for cheap arithmetic.
 *
 * Indexes:
 *   - `idx_jobs_claim` covers the hot claim path (eligible queued rows in
 *     priority/FIFO order). NOTE: because `run_at <= now` is a range predicate
 *     that sorts before the `priority, created_at` ORDER BY columns, SQLite
 *     still performs a small sort step for the claim's ORDER BY — the index
 *     narrows the scan to eligible rows but cannot fully serve the ordering.
 *     Fine at the volumes this queue targets; revisit (e.g. split delayed jobs
 *     or a `(status, priority, created_at)` index with a separate run_at gate)
 *     only if the jobs table grows large enough for the sort to show up.
 *   - `idx_jobs_reaper` covers the stuck-job scan (running rows by claim age).
 */

export const JOBS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK(status IN ('queued', 'running', 'done', 'dead_letter')),
    priority INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER,
    lease_id TEXT,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_claim
    ON jobs(status, run_at, priority ASC, created_at ASC);
  CREATE INDEX IF NOT EXISTS idx_jobs_reaper
    ON jobs(status, claimed_at);
`;
