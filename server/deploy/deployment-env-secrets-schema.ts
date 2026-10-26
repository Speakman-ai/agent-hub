/**
 * SQLite DDL for deploy-environment-scoped secrets.
 *
 * Project secrets (`worktree_preview_secrets`) are merged into every chat
 * session, Finalize CI job, and preview the project spawns. Production deploy
 * credentials must not travel that widely, so they live here instead, keyed by
 * (project_id, environment_name, key). The only reader that decrypts these rows
 * is the deploy orchestrator, for a deployment of that exact environment.
 *
 * Kept in its own table rather than adding an environment column to the
 * project-secrets table: every existing project-secret read path would have to
 * learn to filter, and a single missed `WHERE` would leak prod credentials into
 * agent sessions. A separate table makes the safe default structural.
 *
 * Like `deployment_env_runtime_config`, `environment_name` is not checked
 * against deploy.yaml: an environment removed from the config keeps its secrets
 * until an operator deletes them, and they are never injected anywhere else.
 */
export const DEPLOYMENT_ENV_SECRETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_secrets (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    environment_name  TEXT NOT NULL,
    key               TEXT NOT NULL,
    -- iv:tag:ciphertext (base64 triple) produced by encryptSecret().
    value_ciphertext  TEXT NOT NULL,
    value_iv          TEXT NOT NULL,
    value_tag         TEXT NOT NULL,
    kind              TEXT NOT NULL CHECK(kind IN ('plain','secret')),
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(project_id, environment_name, key)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_secrets_env
    ON deployment_env_secrets(project_id, environment_name);

  CREATE TABLE IF NOT EXISTS deployment_env_secret_audit (
    id                TEXT PRIMARY KEY,
    project_id        TEXT NOT NULL,
    environment_name  TEXT NOT NULL,
    keys              TEXT NOT NULL,
    action            TEXT NOT NULL CHECK(action IN ('upsert','delete','read')),
    actor_user_id     TEXT,
    deployment_id     TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_secret_audit_env
    ON deployment_env_secret_audit(project_id, environment_name, created_at);
`;
