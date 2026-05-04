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
 * Default port range for preview processes. Sits above the PR-env pool's
 * default (3100–3999) so the two ranges never overlap on the same host.
 * 1000 ports is plenty of headroom for the per-session preview use case.
 */
export const DEFAULT_PREVIEW_PORT_RANGE = { min: 4100, max: 4999 } as const;
