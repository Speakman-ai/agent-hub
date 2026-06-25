/**
 * SQLite DDL for the Deployment Module (Phase 2).
 *
 * Four tables model "what is live where" and "how a deploy run went":
 *
 *   - `deployments`            — one row per deploy run (a pipeline execution of
 *                                an environment's `.agent-hub/deploy.yaml` steps
 *                                against a single git ref). The unit of history.
 *   - `deployment_steps`       — per-step state for a run (name, order, status,
 *                                exit code, timing). Mirrors the deploy.yaml step
 *                                list so the UI can render a live progress list.
 *   - `deployment_environments`— the durable per-environment record: which ref is
 *                                currently LIVE (`current_ref` / the deployment
 *                                that put it there) AND the concurrency lock
 *                                (`active_deployment_id`, NULL when idle). One row
 *                                per (project, environment).
 *   - `deployment_approvals`   — approver audit trail for gated environments
 *                                (deploy.yaml `approval: true`): who approved,
 *                                with what org role, and when.
 *
 * Locked epic decisions this schema encodes (see system prompt + epic 6313c155):
 *   - Concurrency: serialize per (project, environment). The active deploy id
 *     lives in `deployment_environments.active_deployment_id`; a trigger to an env
 *     whose lock is set is rejected 409 (enforced by the orchestrator in Phase 3).
 *   - Rollback: a re-run of the same pipeline against a previously-recorded good
 *     ref. Recorded as a normal `deployments` row with `trigger = 'rollback'` and
 *     `source_deployment_id` pointing at the historical deployment it re-runs.
 *   - Approvals: gated environments require Admin/Owner; the triggering user MAY
 *     self-approve in v1. `deployment_approvals` records user id + role + time.
 *
 * `status` carries a CHECK (well-defined state machine — same convention as
 * `workflow_runs` / `delegations`). `trigger` deliberately has NO CHECK so new
 * trigger sources can be added without a CHECK-rewrite migration (same reasoning
 * as `workflows.trigger_type`). `meta` is a nullable JSON stash for forward-compat.
 *
 * Imported by `db.ts` at boot and by `deployment-schema.test.ts` for hermetic
 * shape/migration checks against an in-memory DB.
 */

export const DEPLOYMENT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name (e.g. 'dev', 'staging', 'production'). Matches a key in
    -- the project's deploy.yaml environments map and a deployment_environments row.
    environment TEXT NOT NULL,
    -- Git ref/sha being deployed.
    ref TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'awaiting_approval', 'running', 'success', 'error', 'cancelled')),
    -- How the deploy was triggered. No CHECK: new sources (schedule, webhook, …)
    -- can be added without a migration. Known v1 values: manual, push, rollback.
    trigger TEXT NOT NULL DEFAULT 'manual',
    -- User id that triggered the deploy (NULL for system/push-driven runs).
    triggered_by TEXT,
    -- For trigger='rollback': the historical deployment whose ref this run re-runs.
    source_deployment_id TEXT,
    -- RunnerBackend job id once the orchestrator (Phase 3) acquires a lease.
    runner_job_id TEXT,
    -- Terminal failure message when status='error'.
    error TEXT,
    -- Free-form JSON stash for forward-compat (commit metadata, etc.).
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deployments_project_created
    ON deployments(project_id, created_at DESC);
  -- Per-environment history (the deployment list / rollback ref picker).
  CREATE INDEX IF NOT EXISTS idx_deployments_env_created
    ON deployments(project_id, environment, created_at DESC);

  CREATE TABLE IF NOT EXISTS deployment_steps (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    name TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'running', 'success', 'error', 'skipped', 'cancelled')),
    exit_code INTEGER,
    error TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_steps_deployment
    ON deployment_steps(deployment_id, step_order ASC);

  CREATE TABLE IF NOT EXISTS deployment_environments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    -- The ref currently live in this environment; NULL until the first success.
    current_ref TEXT,
    -- The deployment that put current_ref live (last successful deploy).
    current_deployment_id TEXT,
    -- Concurrency lock: the in-flight deployment id, or NULL when idle. The
    -- orchestrator sets this on acquire and clears it on terminal state; a
    -- trigger while it is non-NULL is rejected 409 (one deploy per env).
    active_deployment_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_environments_project
    ON deployment_environments(project_id);

  CREATE TABLE IF NOT EXISTS deployment_approvals (
    id TEXT PRIMARY KEY,
    deployment_id TEXT NOT NULL,
    approver_user_id TEXT NOT NULL,
    -- The org role held at approval time (Owner / Admin). Recorded for audit so
    -- a later role change doesn't rewrite history.
    approver_role TEXT NOT NULL,
    decision TEXT NOT NULL DEFAULT 'approved'
      CHECK(decision IN ('approved', 'rejected')),
    note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_approvals_deployment
    ON deployment_approvals(deployment_id, created_at ASC);
`;
