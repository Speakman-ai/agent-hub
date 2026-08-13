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
 * Host-port uniqueness (see `ensureHostScopedPreviewPortUniqueness`) plus a
 * bounded retry in the runtime's reservation path (up to 3 attempts) handles
 * the rare race where two concurrent `startPreview()` calls pick the same gap
 * — the loser retries with the next free port. Ports inside a session env are
 * exempt from that uniqueness, because they are not host ports at all.
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
 * the join key from the project's port-map label. Host-port uniqueness
 * spans the whole pool rather than one group, so the allocator semantics
 * from the old single-process table still apply across the multi-process
 * world — two groups can't both claim host port 4101.
 *
 * The two tables are migrated *into* by `MIGRATE_LEGACY_PREVIEWS_SQL`
 * below — any row left in the legacy `worktree_previews` table is
 * folded into the new shape as a 1-process group named `app`.
 */
/**
 * Which port space a process row's `port` lives in.
 *
 * - `host` — a port on the Hub's machine, drawn from the shared preview pool.
 *   Unique host-wide: two processes cannot both bind 4101.
 * - `env`  — a port inside the session env's own network namespace, reached by
 *   dialing the env directly. Namespaced per session, so the same number
 *   recurring across sessions is expected.
 */
export type PreviewDialScope = 'host' | 'env';

/**
 * Partial unique index replacing the original `port INTEGER NOT NULL UNIQUE`.
 *
 * Deliberately *not* part of the CREATE TABLE block above. That block runs
 * `CREATE TABLE IF NOT EXISTS`, which is a no-op against a database whose
 * table predates `dial_scope` — and the index would then be created before the
 * column it filters on exists, failing every boot with "no such column".
 * `ensureHostScopedPreviewPortUniqueness` owns it instead, after the column is
 * guaranteed.
 */
const HOST_PORT_UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_worktree_preview_processes_host_port
    ON worktree_preview_processes(port) WHERE dial_scope = 'host';
`;

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
    -- The port the proxy dials. Which space that number lives in is
    -- dial_scope's job: a host port drawn from the shared pool, or a port
    -- inside the session env's own network namespace.
    port            INTEGER NOT NULL,
    url             TEXT NOT NULL,
    log_path        TEXT,
    status          TEXT NOT NULL CHECK(status IN ('pending','starting','ready','failed')),
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    -- Dev-server companion columns. internal_port is the port from the
    -- project's devServer portMap (what the process is told to serve inside
    -- the session env). is_primary marks the entry that keeps the
    -- back-compat /preview/proxy/ mount. NULL / 0 on older rows.
    internal_port   INTEGER,
    is_primary      INTEGER NOT NULL DEFAULT 0,
    -- Which port space the port column belongs to. See
    -- ensureHostScopedPreviewPortUniqueness below for why uniqueness can
    -- only apply to the 'host' half.
    dial_scope      TEXT NOT NULL DEFAULT 'host' CHECK(dial_scope IN ('host','env')),
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
  -- migrated process row would skip the process INSERT (host-port
  -- uniqueness + INSERT OR IGNORE) but still leave the group row in
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

interface MigrationDb {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

/**
 * Scope preview-port uniqueness to the host port space.
 *
 * The table originally declared `port INTEGER NOT NULL UNIQUE`, which encoded
 * an assumption that every preview port is a host port out of one machine-wide
 * pool. That holds only while the Hub reaches a dev server by publishing it
 * onto the host. A session env that routes by container IP publishes nothing:
 * the process binds inside its own network namespace, so two sessions both
 * serving 4200 is normal — and a global UNIQUE(port) rejects the second one,
 * failing an unrelated session's preview for no reason.
 *
 * Uniqueness therefore applies only to rows the Hub dials on the host
 * (`dial_scope = 'host'`), as a partial unique index. Env-scoped rows are
 * exempt; `UNIQUE(group_id, name)` still keeps one row per named process, so
 * nothing is left unconstrained.
 *
 * SQLite cannot drop a column-level UNIQUE in place, so an existing database
 * needs a table rebuild. Detection reads the stored DDL rather than probing
 * `PRAGMA index_list` for an auto-index name, since the latter is an
 * implementation detail. Fresh databases already ship the new shape and skip
 * straight to the index.
 *
 * Must run *after* {@link ensureDevServerPreviewColumns}: the rebuild copies
 * `internal_port` / `is_primary`, so those columns have to exist first.
 */
export function ensureHostScopedPreviewPortUniqueness(db: MigrationDb): void {
  try {
    db.exec(
      `ALTER TABLE worktree_preview_processes
         ADD COLUMN dial_scope TEXT NOT NULL DEFAULT 'host'`,
    );
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (!msg.includes('duplicate column name')) throw err;
  }

  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get('worktree_preview_processes') as { sql?: string } | undefined;
  // A CHECK on dial_scope is only present on the rebuilt/fresh shape, so its
  // absence alone does not imply the old UNIQUE. Test for the constraint
  // itself: `port INTEGER NOT NULL UNIQUE`, allowing any run of whitespace.
  const hasGlobalPortUnique = /\bport\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\b/i.test(row?.sql ?? '');

  if (hasGlobalPortUnique) {
    // Single exec so the rebuild is one transaction: a crash mid-way would
    // otherwise leave the table dropped and the data only in the temp copy.
    db.exec(`
      BEGIN;
      CREATE TABLE worktree_preview_processes_rebuild (
        id              TEXT PRIMARY KEY,
        group_id        TEXT NOT NULL REFERENCES worktree_preview_groups(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        pid             INTEGER,
        port            INTEGER NOT NULL,
        url             TEXT NOT NULL,
        log_path        TEXT,
        status          TEXT NOT NULL CHECK(status IN ('pending','starting','ready','failed')),
        started_at      TEXT NOT NULL DEFAULT (datetime('now')),
        internal_port   INTEGER,
        is_primary      INTEGER NOT NULL DEFAULT 0,
        dial_scope      TEXT NOT NULL DEFAULT 'host' CHECK(dial_scope IN ('host','env')),
        UNIQUE(group_id, name)
      );
      INSERT INTO worktree_preview_processes_rebuild
        (id, group_id, name, pid, port, url, log_path, status, started_at,
         internal_port, is_primary, dial_scope)
      SELECT id, group_id, name, pid, port, url, log_path, status, started_at,
             internal_port, is_primary, COALESCE(dial_scope, 'host')
        FROM worktree_preview_processes;
      DROP TABLE worktree_preview_processes;
      ALTER TABLE worktree_preview_processes_rebuild
        RENAME TO worktree_preview_processes;
      CREATE INDEX IF NOT EXISTS idx_worktree_preview_processes_group
        ON worktree_preview_processes(group_id);
      CREATE INDEX IF NOT EXISTS idx_worktree_preview_processes_status
        ON worktree_preview_processes(status);
      COMMIT;
    `);
  }

  db.exec(HOST_PORT_UNIQUE_INDEX_SQL);
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
 * stop their processes now, so leaving them behind would pin their host ports
 * against the allocator forever. Dev-server rows
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
 * Drop preview rows served from inside a session container.
 *
 * A dev server in a session env is reachable only through the in-memory
 * `SessionEnv` handle that owns its container, and a restart destroys every one
 * of those (the boot reconcile sweep then removes the containers themselves).
 * The rows, however, live in SQLite and survive — so without this the Hub comes
 * back advertising a ready preview whose upstream no longer exists, and the
 * proxy answers `502 ECONNREFUSED` forever while the UI shows it running. The
 * only recovery was to stop and restart the preview by hand.
 *
 * Deleting rather than marking `stopped` is deliberate and matches
 * {@link deleteOrphanedNonDevServerPreviewRows}: it clears the way for a fresh
 * start on the same ports and makes the UI offer "Start preview" again.
 *
 * Host-scoped rows are left alone. Those are reclaimed by liveness, not by
 * assumption (see `preview-port-reclaim.ts`) — a published host port can belong
 * to a process this Hub did not spawn.
 */
export function deleteEnvScopedPreviewRows(db: {
  prepare(sql: string): {
    run(...args: unknown[]): { changes: number };
    all(...args: unknown[]): unknown[];
  };
}): number {
  const affected = db
    .prepare(
      `SELECT DISTINCT group_id AS groupId
         FROM worktree_preview_processes
        WHERE dial_scope = 'env'`,
    )
    .all() as Array<{ groupId: string }>;
  if (affected.length === 0) return 0;

  db.prepare(`DELETE FROM worktree_preview_processes WHERE dial_scope = 'env'`).run();

  // Only groups emptied by the delete above are removed, so a group that still
  // has a host-dialed process (a mixed-routing row set) keeps its identity.
  let groupsRemoved = 0;
  for (const { groupId } of affected) {
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE group_id = ?`)
      .all(groupId) as Array<{ n: number }>;
    if ((remaining[0]?.n ?? 0) > 0) continue;
    db.prepare(`DELETE FROM worktree_preview_groups WHERE id = ?`).run(groupId);
    db.prepare(`DELETE FROM worktree_previews WHERE id = ?`).run(groupId);
    groupsRemoved += 1;
  }
  return groupsRemoved;
}

/**
 * Default port range for preview processes. Sits above the PR-env pool's
 * default (3100–3999) so the two ranges never overlap on the same host.
 * 1000 ports is plenty of headroom for the per-session preview use case.
 */
export const DEFAULT_PREVIEW_PORT_RANGE = { min: 4100, max: 4999 } as const;
