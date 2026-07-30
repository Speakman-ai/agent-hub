/**
 * Worktree-preview schema.
 *
 * One row per active preview process. Lifecycle is owned by
 * `dev-server-runtime.ts`; its reaper walks the table
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
/**
 * `worktree_preview_groups.runtime` value for rows the dev-server
 * runtime owns. Lives here (beside the column definition) so callers
 * that only need to discriminate a row don't have to import the whole
 * runtime module.
 */
export const DEV_SERVER_RUNTIME_KIND = 'dev-server';

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
 * the join key from the project's port-map label. We keep
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
    last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
    -- Runtime ownership discriminator. 'dev-server' for DevServerRuntime
    -- rows, which is the only runtime that writes here. Retained rather
    -- than assumed so the reap pass can still recognise and clear rows
    -- left behind by a retired runtime.
    runtime TEXT
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
    -- Dev-server companion columns. port stores the HOST port the
    -- proxy dials; internal_port is the port from the project's
    -- devServer portMap (what the process is told to serve inside the
    -- session env). is_primary marks the entry that keeps the
    -- back-compat /preview/proxy/ mount. NULL / 0 on older rows.
    -- rows.
    internal_port   INTEGER,
    is_primary      INTEGER NOT NULL DEFAULT 0,
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

  -- Sanity cleanup: a legacy row whose port collides with an already-
  -- migrated process row would skip the process INSERT (UNIQUE(port)
  -- conflict + INSERT OR IGNORE) but still leave the group row in
  -- place. Drop any orphan groups so callers never see a group with
  -- zero processes. Restricted to groups whose id matches a legacy
  -- row so we never touch live, runtime-managed groups that are
  -- mid-reservation (those don't go through this migration path).
  DELETE FROM worktree_preview_groups
   WHERE id IN (SELECT id FROM worktree_previews)
     AND NOT EXISTS (
       SELECT 1 FROM worktree_preview_processes
        WHERE group_id = worktree_preview_groups.id
     );
`;

/**
 * Idempotent column backfill for databases created before the dev-server
 * runtime columns were promoted into the base schema above. Mirrors the
 * the previous runtime migration pattern:
 * `ALTER TABLE … ADD COLUMN` is fast and atomic, and the duplicate-column
 * error is swallowed per-statement so a partially-migrated DB still picks
 * up the remaining additions. Called by the dev-server runtime constructor.
 */
export function ensureDevServerPreviewColumns(db: { exec(sql: string): unknown }): void {
  const additions = [
    `ALTER TABLE worktree_preview_groups ADD COLUMN runtime TEXT`,
    `ALTER TABLE worktree_preview_processes ADD COLUMN internal_port INTEGER`,
    `ALTER TABLE worktree_preview_processes ADD COLUMN is_primary INTEGER NOT NULL DEFAULT 0`,
  ];
  for (const stmt of additions) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
}

/**
 * Columns older preview runtimes added to `worktree_preview_groups` at
 * construction time. The dev-server runtime never writes them, so on an
 * existing database they are dead weight.
 *
 * `ALTER TABLE … DROP COLUMN` needs SQLite 3.35+ (better-sqlite3 bundles
 * well past that). An unknown column raises "no such column", which we
 * swallow per-statement so a fresh database — where the base schema never
 * declared them — is a clean no-op.
 */
export function dropComposePreviewColumns(db: { exec(sql: string): unknown }): void {
  const drops = [
    `ALTER TABLE worktree_preview_groups DROP COLUMN compose_project_name`,
    `ALTER TABLE worktree_preview_groups DROP COLUMN worktree_path`,
    `ALTER TABLE worktree_preview_groups DROP COLUMN compose_file`,
    `ALTER TABLE worktree_preview_groups DROP COLUMN entry_port`,
    `ALTER TABLE worktree_preview_groups DROP COLUMN override_file_path`,
    `ALTER TABLE worktree_preview_groups DROP COLUMN host_project_directory`,
  ];
  for (const stmt of drops) {
    try {
      db.exec(stmt);
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('no such column')) continue;
      throw err;
    }
  }
}

/**
 * Rows older runtimes owned. Nothing can
 * stop their processes now, so leaving them behind would pin their ports
 * against the allocator's UNIQUE(port) invariant forever. Dev-server rows
 * (`runtime = 'dev-server'`) are never touched.
 */
export function deleteOrphanedNonDevServerPreviewRows(db: {
  prepare(sql: string): { run(...args: unknown[]): { changes: number } };
}): number {
  // Child rows go first: the FK declares ON DELETE CASCADE but that only
  // fires when `PRAGMA foreign_keys` is ON, which is a per-connection
  // setting. Deleting explicitly makes the sweep correct either way.
  db.prepare(
    `DELETE FROM worktree_preview_processes
      WHERE group_id IN (
        SELECT id FROM worktree_preview_groups
         WHERE runtime IS NULL OR runtime <> '${DEV_SERVER_RUNTIME_KIND}'
      )`,
  ).run();
  const { changes } = db
    .prepare(
      `DELETE FROM worktree_preview_groups
        WHERE runtime IS NULL OR runtime <> '${DEV_SERVER_RUNTIME_KIND}'`,
    )
    .run();
  return changes;
}

/**
 * Default port range for preview processes. Sits above the PR-env pool's
 * default (3100–3999) so the two ranges never overlap on the same host.
 * 1000 ports is plenty of headroom for the per-session preview use case.
 */
export const DEFAULT_PREVIEW_PORT_RANGE = { min: 4100, max: 4999 } as const;
