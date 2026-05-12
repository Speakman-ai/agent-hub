/**
 * Worktree-preview schema.
 *
 * One row per active preview process. Lifecycle is owned by
 * `preview-runtime.ts`; the reaper (`preview-reaper.ts`) walks the table
 * each tick and tears down rows whose `last_active_at` is past the
 * configured idle TTL.
 *
 * Why a dedicated table rather than reusing `pool_slots` / `pr_env_ports`?
 *   - Different scope: preview ⇄ session, PR-env ⇄ (repo, PR).
 *   - Different lifetime: preview is bounded by chat activity, PR-env by
 *     GitHub PR state.
 *   - Different cleanup signal: preview is reaped on idle TTL + session
 *     end; PR-env is reaped on PR close + crashed-scaffold timeouts.
 *
 * Keeping the two pools separate matches the same "different shape,
 * different lifecycle, different UNIQUE key" rationale documented in
 * `port-pool.ts`.
 *
 * The `UNIQUE(port)` constraint plus a bounded retry in `insertStartingRow`
 * (up to 3 attempts) handles the rare race where two concurrent
 * `startPreview()` calls pick the same gap — the loser retries with the
 * next free port.
 *
 * Status state machine:
 *   `starting` → `ready`    (health-check succeeded)
 *               → `failed`  (health-check timed out / spawn errored /
 *                            child exited during startup)
 *   `ready`    → `failed`   (child error event)
 *               → (deleted) (idle reap, session-end, or replace-on-restart
 *                            via stopPreview)
 *   `failed`   → (deleted)  (stopPreview called by session-end or
 *                            replace-on-restart; process was already killed
 *                            by markFailed)
 *
 * 'failed' rows have their child process SIGTERMed immediately by
 * `markFailed` and are excluded from the port allocator query (only
 * 'starting'/'ready' rows count as taken). This prevents a busted
 * startScript from exhausting the port pool. `getActiveBySessionId()`
 * includes 'failed' rows so the replace-on-restart guard can sweep them.
 */
export const WORKTREE_PREVIEWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS worktree_previews (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    pid             INTEGER,
    port            INTEGER NOT NULL UNIQUE,
    url             TEXT NOT NULL,
    log_path        TEXT,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
    status          TEXT NOT NULL CHECK(status IN ('starting','ready','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_previews_session ON worktree_previews(session_id);
  CREATE INDEX IF NOT EXISTS idx_worktree_previews_status  ON worktree_previews(status);
`;

/**
 * Multi-process preview tables.
 *
 * `worktree_preview_groups` is the per-session container — one row per
 * active preview, regardless of how many child processes back it. Its
 * `status` is a rollup of the per-process statuses (any `failed` →
 * `failed`; all `ready` → `ready`; otherwise `starting`) so callers
 * that only care about the group don't have to JOIN.
 *
 * `worktree_preview_processes` is the per-process detail row. Carries
 * its own pid, port, URL, status, and log path. The `name` column is
 * the join key from the project's `PreviewProcess.name` field. We keep
 * `UNIQUE(port)` global to the preview pool (not scoped per group) so
 * the same allocator semantics from the old single-process table still
 * apply across the new multi-process world — two groups can't both
 * claim port 4101.
 *
 * The two tables are migrated *into* by `MIGRATE_LEGACY_PREVIEWS_SQL`
 * below — any row left in the legacy `worktree_previews` table is
 * folded into the new shape as a 1-process group named `app`.
 */
export const WORKTREE_PREVIEW_GROUPS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS worktree_preview_groups (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL,
    project_id      TEXT NOT NULL,
    status          TEXT NOT NULL CHECK(status IN ('starting','ready','failed')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_groups_session
    ON worktree_preview_groups(session_id);
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_groups_status
    ON worktree_preview_groups(status);

  CREATE TABLE IF NOT EXISTS worktree_preview_processes (
    id              TEXT PRIMARY KEY,
    group_id        TEXT NOT NULL REFERENCES worktree_preview_groups(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    pid             INTEGER,
    port            INTEGER NOT NULL UNIQUE,
    url             TEXT NOT NULL,
    log_path        TEXT,
    status          TEXT NOT NULL CHECK(status IN ('pending','starting','ready','failed')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(group_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_processes_group
    ON worktree_preview_processes(group_id);
  CREATE INDEX IF NOT EXISTS idx_worktree_preview_processes_status
    ON worktree_preview_processes(status);
`;

/**
 * Migration from the legacy `worktree_previews` (one-process-per-row)
 * shape to the new groups + processes shape.
 *
 * Idempotent — re-running on a freshly-migrated database is a no-op
 * because the SELECT returns zero rows once the source has been
 * drained. We retain the old table itself (rather than DROP) so a
 * downgrade path is possible during the rollout window; once the new
 * runtime is stable in prod the old table can be removed in a later
 * migration without losing data (the new tables already hold the
 * canonical state).
 *
 * Conversion rules:
 *   - One legacy row → one group row + one `app`-named process row.
 *   - status, pid, port, url, log_path, started_at, last_active_at all
 *     carry over unchanged.
 *   - The process inherits the group id's session_id / project_id via
 *     the JOIN at read time; no duplication of those fields on the
 *     process row.
 */
export const MIGRATE_LEGACY_PREVIEWS_SQL = `
  INSERT OR IGNORE INTO worktree_preview_groups
    (id, session_id, project_id, status, started_at, last_active_at)
  SELECT id, session_id, project_id, status, started_at, last_active_at
    FROM worktree_previews;

  INSERT OR IGNORE INTO worktree_preview_processes
    (id, group_id, name, pid, port, url, log_path, status, started_at)
  SELECT id || ':app', id, 'app', pid, port, url, log_path, status, started_at
    FROM worktree_previews
   WHERE NOT EXISTS (
     SELECT 1 FROM worktree_preview_processes WHERE group_id = worktree_previews.id
   );
`;

/**
 * Default port range for preview processes. Sits above the PR-env pool's
 * default (3100–3999) so the two ranges never overlap on the same host.
 * 1000 ports is plenty of headroom for the per-session preview use case.
 */
export const DEFAULT_PREVIEW_PORT_RANGE = { min: 4100, max: 4999 } as const;
