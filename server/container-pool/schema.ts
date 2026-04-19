/**
 * Container Pool — SQLite schema (W1).
 *
 * Three tables back the dispatcher/pool subsystem described in the wiki page
 * "Container Pool — PR Envs + Scaffolding" (§Appendix A):
 *
 *   pool_slots   — one row per runtime slot (PR env or scaffold). Tracks the
 *                  currently bound container, its state, and last activity so
 *                  the reaper can identify idle/stale slots.
 *
 *   pool_queue   — pending work items waiting for a free slot. Rows are
 *                  dequeued in (priority_tier DESC, enqueued_at ASC) order.
 *                  `priority_tier` is wired through now behind the pending
 *                  "enterprise opt-out" decision — non-enterprise tenants will
 *                  pin to tier 0 until that lands.
 *
 *   pool_metrics — append-only per-tick snapshot used for the heartbeat alert
 *                  rules (queue depth, evictions, reaps) and the /settings/pool
 *                  sparklines. 7-day retention handled by the dispatcher.
 *
 * Schema is exported as a string so both the production DB bootstrap
 * (server/db.ts) and unit tests (in-memory :memory: DB) can apply it
 * identically with no drift.
 */

export const POOL_SCHEMA = `
  -- Pool slots: one row per concurrency slot. slot_id is assigned by the
  -- dispatcher and is stable for the process lifetime (e.g. "pr-1".."pr-8",
  -- "scaffold-1".."scaffold-3", "overflow-1"). container_id is set when a
  -- container is bound to the slot and cleared on release.
  CREATE TABLE IF NOT EXISTS pool_slots (
    slot_id          TEXT PRIMARY KEY,
    class            TEXT NOT NULL CHECK(class IN ('pr_env','scaffold','overflow')),
    status           TEXT NOT NULL DEFAULT 'free'
                       CHECK(status IN ('free','reserved','busy','draining')),
    container_id     TEXT,
    started_at       TEXT,
    last_activity_at TEXT,
    -- A given Docker container must only ever be bound to one slot. NULL
    -- container_ids are allowed to repeat (free slots). Partial UNIQUE index
    -- gives us that semantic since SQLite's table-level UNIQUE counts NULLs
    -- as distinct anyway — the partial index makes the intent explicit.
    UNIQUE(container_id)
  );

  -- Pool queue: pending work items. status flows
  -- queued -> dispatching -> (removed on success) OR queued -> failed.
  -- payload is opaque JSON (PR number + branch for pr_env, scaffold spec for
  -- scaffold). priority_tier is INTEGER so ORDER BY priority_tier DESC works
  -- without a custom collation; higher numbers win. Default 0 keeps parity
  -- with the legacy single-tier behaviour while the enterprise opt-out
  -- decision is pending.
  CREATE TABLE IF NOT EXISTS pool_queue (
    id             TEXT PRIMARY KEY,
    class          TEXT NOT NULL CHECK(class IN ('pr_env','scaffold')),
    payload        TEXT NOT NULL,
    priority_tier  INTEGER NOT NULL DEFAULT 0,
    enqueued_at    TEXT NOT NULL DEFAULT (datetime('now')),
    status         TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','dispatching','failed'))
  );
  -- Drives the dispatcher's hot path: "give me the oldest queued item per
  -- class". status is the leading column so SQLite can satisfy the filter
  -- without a sort on enqueued_at.
  CREATE INDEX IF NOT EXISTS idx_pool_queue_status_enqueued_at
    ON pool_queue(status, enqueued_at);

  -- Pool metrics: append-only snapshot written by the dispatcher every 60s.
  -- pool_util is a fraction in [0,1]; queue_depth is the sum across classes
  -- at sample time. evictions/reaps are per-sample counters (not cumulative).
  CREATE TABLE IF NOT EXISTS pool_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    pool_util   REAL NOT NULL,
    queue_depth INTEGER NOT NULL,
    evictions   INTEGER NOT NULL DEFAULT 0,
    reaps       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pool_metrics_timestamp
    ON pool_metrics(timestamp);
`;
