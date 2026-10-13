import type Database from 'better-sqlite3';

/**
 * `pr_environments`: one row per pull request that has (or had) a PR
 * environment. Keyed by (project, source, PR number), never by session, so a
 * PR on any head branch can get an environment. `generation` bumps on every
 * (re)build so late runtime callbacks from a superseded build are ignored.
 * `log_tail` is a JSON array of the most recent runtime log lines.
 * Timestamps are epoch ms, like `pull_requests`.
 */
export const PR_ENVIRONMENTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pr_environments (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL,
    source       TEXT NOT NULL CHECK(source IN ('native', 'github')),
    pr_number    INTEGER NOT NULL,
    head_sha     TEXT NOT NULL,
    head_branch  TEXT,
    status       TEXT NOT NULL
                 CHECK(status IN ('queued','building','ready','failed','stopped')),
    generation   INTEGER NOT NULL DEFAULT 1,
    url          TEXT,
    runner_ref   TEXT,
    error        TEXT,
    stop_reason  TEXT,
    log_tail     TEXT NOT NULL DEFAULT '[]',
    -- 1 while a requested teardown is unconfirmed (retried on stop/close).
    cleanup_pending INTEGER NOT NULL DEFAULT 0,
    -- JSON {generation, headSha, headBranch, runnerRef, url} of the build the
    -- pending teardown must remove; NULL once the teardown is confirmed.
    cleanup_target TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    ready_at     INTEGER,
    stopped_at   INTEGER,
    -- Last request through the ingress proxy (throttled), for the idle TTL.
    last_hit_at  INTEGER,
    -- When the max-lifetime clock last restarted: created, head moved, or
    -- started manually.
    renewed_at   INTEGER,
    UNIQUE(project_id, source, pr_number)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_environments_project_status
    ON pr_environments(project_id, status);

`;

/**
 * Databases created before GitHub-hosted PRs could have environments carry
 * `CHECK(source IN ('native'))`, which SQLite cannot alter in place. Rebuild
 * the table under the current schema, keeping every row. Runs after
 * `PR_ENVIRONMENTS_SCHEMA`; a no-op once the constraint allows `github`.
 */
export function migratePrEnvironmentsSourceCheck(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'pr_environments'")
    .get() as { sql: string } | undefined;
  if (!row || /'github'/.test(row.sql)) return false;
  const columns = (
    db.prepare('PRAGMA table_info(pr_environments)').all() as Array<{ name: string }>
  )
    .map((c) => `"${c.name}"`)
    .join(', ');
  db.transaction(() => {
    db.exec('ALTER TABLE pr_environments RENAME TO pr_environments_source_migration');
    db.exec('DROP INDEX IF EXISTS idx_pr_environments_project_status');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    db.exec(
      `INSERT INTO pr_environments (${columns}) SELECT ${columns} FROM pr_environments_source_migration`,
    );
    db.exec('DROP TABLE pr_environments_source_migration');
  })();
  return true;
}

/**
 * Add the cost-control columns to databases created before them. Existing
 * rows start their lifetime clock at their last update, so a deploy does not
 * expire every environment at once. Idempotent.
 */
export function migratePrEnvironmentsUsageColumns(db: Database.Database): void {
  const cols = new Set(
    (db.prepare('PRAGMA table_info(pr_environments)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  if (!cols.has('last_hit_at'))
    db.exec('ALTER TABLE pr_environments ADD COLUMN last_hit_at INTEGER');
  if (!cols.has('renewed_at')) db.exec('ALTER TABLE pr_environments ADD COLUMN renewed_at INTEGER');
  db.exec('UPDATE pr_environments SET renewed_at = updated_at WHERE renewed_at IS NULL');
}
