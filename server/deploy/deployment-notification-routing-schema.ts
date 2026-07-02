/**
 * SQLite DDL for per-environment NOTIFICATION ROUTING (multi-environment
 * management — the notification-routing phase on top of the
 * `environments-config` runtime-config layer).
 *
 * Locked epic decision `notification-routing`:
 *   Per-(project, environment) config selects which release notification types
 *   (`ticket_release`, `release_digest`) fire when a deployment to that
 *   environment succeeds. Production defaults to reporter + digest; non-prod
 *   sends nothing until an operator explicitly enables it. A missing row means
 *   "default" — resolved by environment name in the store, NOT stored — so the
 *   existing prod-only notification behaviour is unchanged until an operator
 *   opts a specific environment in or out. The idempotency keys already carry
 *   `deployment_id`, so per-env routing never double-sends.
 *
 *   - `deployment_env_notification_routing` — at most one row per
 *     (project, environment). `ticket_release_enabled` /
 *     `release_digest_enabled` are the per-type on/off switches. `meta` is a
 *     nullable JSON stash for forward-compat.
 *
 * Like the sibling runtime-config / trigger / schedule tables this intentionally
 * does NOT enforce that `environment_name` matches a current deploy.yaml
 * environment: deploy.yaml is edited out-of-band, so a routing row whose
 * environment was removed is retained and simply never consulted (no deployment
 * ever targets a non-declared environment). The CRUD API guards against typos by
 * requiring the environment to be declared or already configured at write time.
 *
 * `ticket_release_enabled` / `release_digest_enabled` carry CHECKs (0/1 only).
 * Kept in its own const/file (not folded into DEPLOYMENT_SCHEMA) so
 * `deployment-notification-routing-schema.test.ts` can migrate an in-memory DB
 * in isolation and the Phase-2 schema test's table-set assertion is unaffected.
 * Imported by `db.ts` at boot and by the store's tests for hermetic checks.
 */

export const DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_notification_routing (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name; matches a key in the project's deploy.yaml environments
    -- map WHILE that environment is declared. A row whose environment was
    -- removed from deploy.yaml is retained and simply never consulted.
    environment_name TEXT NOT NULL,
    -- Whether the ticket_release (reporter) notification fires for a successful
    -- deployment to this environment.
    ticket_release_enabled INTEGER NOT NULL DEFAULT 0 CHECK(ticket_release_enabled IN (0, 1)),
    -- Whether the release_digest notification fires for a successful deployment
    -- to this environment.
    release_digest_enabled INTEGER NOT NULL DEFAULT 0 CHECK(release_digest_enabled IN (0, 1)),
    -- Free-form JSON stash for forward-compat.
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, environment_name)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_notification_routing_project
    ON deployment_env_notification_routing(project_id);
`;
