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
    source       TEXT NOT NULL CHECK(source IN ('native')),
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
    UNIQUE(project_id, source, pr_number)
  );
  CREATE INDEX IF NOT EXISTS idx_pr_environments_project_status
    ON pr_environments(project_id, status);

`;
