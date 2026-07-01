/**
 * SQLite DDL for per-environment RUNTIME config (multi-environment management,
 * Phase 5 — the foundation the triggers / scheduling / notification-routing
 * phases build on).
 *
 * Locked epic decision `environments-config`: `.agent-hub/deploy.yaml` stays the
 * source of truth for WHICH environments exist and their pipeline steps (the
 * pure parser in `deploy-config.ts` is unchanged). Operator-editable runtime
 * config — enable/disable here, plus git-event triggers, schedules, and
 * notification routing in later phases — lives in DB tables keyed by
 * (project_id, environment_name) so an operator can pause an environment or flip
 * a setting WITHOUT a commit.
 *
 *   - `deployment_env_runtime_config` — one row per (project, environment) that
 *     an operator has configured. `enabled` is the environment-level on/off
 *     switch (a temporary pause, retained, not a delete). A missing row means
 *     "default" (enabled), so the existing manual-deploy behaviour is unchanged
 *     until an operator opts into pausing an environment.
 *
 * This table intentionally does NOT enforce that `environment_name` matches a
 * current deploy.yaml environment: deploy.yaml is edited out-of-band, and a
 * config row whose environment was removed must be SURFACED as inactive rather
 * than silently dropped or silently deployed. That active/deployable resolution
 * lives in `deployment-env-config-store.ts` (`resolveEnvironmentConfigs`), which
 * cross-references the config rows against the names the parser reports.
 *
 * `enabled` carries a CHECK (0/1 only). `meta` is a nullable JSON stash for
 * forward-compat. Kept in its own const/file (not folded into DEPLOYMENT_SCHEMA)
 * so `deployment-env-config-schema.test.ts` can migrate an in-memory DB in
 * isolation and the Phase-2 schema test's table-set assertion is unaffected.
 *
 * Imported by `db.ts` at boot and by the store's tests for hermetic checks.
 */

export const DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_runtime_config (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name; matches a key in the project's deploy.yaml environments
    -- map WHILE that environment is declared. A row whose environment was
    -- removed from deploy.yaml is retained and resolves as inactive.
    environment_name TEXT NOT NULL,
    -- Operator on/off switch for this environment's automation. 1 = enabled
    -- (default). A disabled environment is retained (a pause, not a delete) and
    -- resolves as not deployable.
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    -- Free-form JSON stash for forward-compat.
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, environment_name)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_runtime_config_project
    ON deployment_env_runtime_config(project_id);
`;
