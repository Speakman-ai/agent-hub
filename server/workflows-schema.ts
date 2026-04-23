/**
 * SQLite DDL for Hub workflow builder (MVP).
 *
 * `parallel_group` is reserved for future parallel steps; the engine ignores it in MVP.
 * `condition_expr` is a nullable stub for future conditional branching.
 * `step_project_id` is nullable: when set, the step runs in that project's workspace context
 *   and the `agent_id` must belong to that project (cross-project pipeline / Phase 3).
 *
 * Imported by `db.ts` at boot and by `workflows-schema.test.ts` for hermetic checks.
 */

export const WORKFLOWS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS workflows (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    -- MVP: only manual triggers; additional trigger types can be added later without a CHECK migration.
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    default_payload TEXT NOT NULL DEFAULT '{}',
    -- V1.1: optional node-cron expression; when set, server registers a schedule (see workflow-triggers.ts).
    cron_expr TEXT,
    cron_next_run_at TEXT,
    -- Per-workflow webhook: opaque URL token + HMAC signing secret (plain at rest; rotate from UI).
    webhook_path_token TEXT,
    webhook_signing_secret TEXT,
    -- V1.1: when set, moving a card into this kanban column starts a run (see workflow-triggers.ts).
    trigger_column_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_workflows_project ON workflows(project_id);
  /* Partial unique index on webhook_path_token is created in db.initDb *after* ALTERs
   * that add the column to legacy DBs — do not put it in this string or boot fails with
   * "no such column" when the workflows table pre-dates the webhook columns. */

  CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    title TEXT NOT NULL,
    role_prompt TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    timeout_ms INTEGER,
    on_failure TEXT NOT NULL DEFAULT 'abort'
      CHECK(on_failure IN ('abort', 'continue', 'retry')),
    condition_expr TEXT,
    parallel_group INTEGER,
    step_project_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow ON workflow_steps(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_steps_workflow_order ON workflow_steps(workflow_id, step_order ASC);

  CREATE TABLE IF NOT EXISTS workflow_runs (
    id TEXT PRIMARY KEY,
    workflow_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'running', 'success', 'error', 'cancelled')),
    run_payload TEXT,
    error TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(workflow_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_runs_status ON workflow_runs(workflow_id, status);

  CREATE TABLE IF NOT EXISTS workflow_step_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL,
    workflow_step_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'running', 'success', 'error', 'skipped', 'cancelled')),
    output TEXT,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
    FOREIGN KEY (workflow_step_id) REFERENCES workflow_steps(id) ON DELETE CASCADE,
    UNIQUE(workflow_run_id, workflow_step_id)
  );
  CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_run ON workflow_step_runs(workflow_run_id);
  CREATE INDEX IF NOT EXISTS idx_workflow_step_runs_step ON workflow_step_runs(workflow_step_id);
`;

/** Applied in db.initDb only after column migrations; also used in workflows-schema tests. */
export const WORKFLOWS_WEBHOOK_PATH_INDEX_SQL = `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_webhook_token ON workflows(webhook_path_token)
  WHERE webhook_path_token IS NOT NULL`;
