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
    -- 'failed' is a terminal state entered when the container exited due
    -- to a quota violation (OOM kill, pids cap). The reaper / operator
    -- must call reclaim() to move it back to 'free'; until then the slot
    -- is held out of the dispatch pool so we don't re-bind onto a known
    -- broken runtime before someone inspects what happened.
    status           TEXT NOT NULL DEFAULT 'free'
                       CHECK(status IN ('free','reserved','busy','draining','failed')),
    container_id     TEXT,
    started_at       TEXT,
    last_activity_at TEXT,
    -- Structured exit reason recorded when a container is reaped. JSON
    -- blob written by the lifecycle layer (see docker-lifecycle.ts).
    -- Cleared on reclaim back to 'free'. NULL for slots that have never
    -- failed.
    last_error       TEXT,
    -- W4 eviction scoring metadata. Populated by the lifecycle layer from
    -- the GitHub webhook path (PR state / commits) and by the Nginx access
    -- log tailer / review webhook (HTTP hits / reviewer activity). All are
    -- nullable — a slot that has never recorded a hit simply scores 0 on
    -- the corresponding term. See wiki §4.1 for the full formula.
    pr_number            INTEGER,
    pr_state             TEXT
                           CHECK(pr_state IS NULL OR pr_state IN ('open','closed','draft')),
    pr_last_commit_at    TEXT,
    last_http_hit_at     TEXT,
    reviewer_activity_at TEXT,
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
  -- W4: queue_depth_pr_env / queue_depth_scaffold are per-class breakdowns
  -- so the dashboard can show which queue is backing up. cert_days_remaining
  -- is the wildcard cert's remaining lifetime in days at sample time —
  -- nullable because the renewer may not yet have populated it (or the
  -- prEnv feature may be disabled). All new columns are nullable / defaulted
  -- so legacy rows from before the W4 migration still satisfy NOT NULL.
  CREATE TABLE IF NOT EXISTS pool_metrics (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp                TEXT NOT NULL DEFAULT (datetime('now')),
    pool_util                REAL NOT NULL,
    queue_depth              INTEGER NOT NULL,
    queue_depth_pr_env       INTEGER NOT NULL DEFAULT 0,
    queue_depth_scaffold     INTEGER NOT NULL DEFAULT 0,
    evictions                INTEGER NOT NULL DEFAULT 0,
    reaps                    INTEGER NOT NULL DEFAULT 0,
    cert_days_remaining      REAL
  );
  CREATE INDEX IF NOT EXISTS idx_pool_metrics_timestamp
    ON pool_metrics(timestamp);

  -- Pool alerts: append-only log of threshold-breach events emitted by the
  -- pool-alerts heartbeat (W4 observability). Each row represents a single
  -- firing — the heartbeat dedupes against the most recent un-resolved row
  -- of the same alert_type so a sustained breach produces one row, not one
  -- per tick. resolved_at is set when a subsequent tick observes the
  -- breach has cleared. severity is informational (info|warn|critical).
  CREATE TABLE IF NOT EXISTS pool_alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_type   TEXT NOT NULL CHECK(alert_type IN ('pool_util_high','queue_depth_high','cert_expiring')),
    severity     TEXT NOT NULL DEFAULT 'warn' CHECK(severity IN ('info','warn','critical')),
    message      TEXT NOT NULL,
    fired_at     TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at  TEXT,
    -- Numeric snapshot of the breach value at fire time for the UI
    -- (e.g. pool_util at 0.95, queue_depth=12, cert_days=7).
    value        REAL
  );
  CREATE INDEX IF NOT EXISTS idx_pool_alerts_active
    ON pool_alerts(alert_type, resolved_at);
  CREATE INDEX IF NOT EXISTS idx_pool_alerts_fired_at
    ON pool_alerts(fired_at);
`;
