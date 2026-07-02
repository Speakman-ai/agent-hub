/**
 * SQLite DDL for per-environment DEPLOY TRIGGERS (multi-environment management —
 * the triggers phase on top of the `environments-config` runtime-config layer).
 *
 * Locked epic decision `deploy-triggers`:
 *   A trigger is a DB row `{environment, event(push|merge), branch pattern,
 *   enabled}`. It is evaluated in the same `onPush` (smart-HTTP) + native-PR
 *   `afterMerge` hooks the security-audit push scan uses. A matching branch
 *   update enqueues a deployment (trigger=push) for the mapped environment,
 *   honoring the per-env concurrency lock; failures are logged and swallowed.
 *   There is NO deploy.yaml trigger block — triggers are operator-editable
 *   without a commit, keyed by (project_id, environment_name) exactly like the
 *   runtime config store.
 *
 * This card owns only the STORE + CRUD API. The hook evaluation / enqueue path
 * is a sibling card that consumes {@link findMatchingTriggers} from the store.
 *
 *   - `deployment_env_trigger` — zero-or-more rows per (project, environment).
 *     `event` is the git event that fires the trigger. `branch_pattern` is a
 *     glob matched against the updated branch (see `branchMatchesPattern` in the
 *     store). `enabled` is the operator on/off switch (a disabled trigger is
 *     retained, a pause not a delete). `meta` is a nullable JSON stash for
 *     forward-compat.
 *
 * Like the runtime-config table this intentionally does NOT enforce that
 * `environment_name` matches a current deploy.yaml environment: deploy.yaml is
 * edited out-of-band, so a trigger whose environment was removed is retained and
 * simply never fires (the hook resolves deployability against deploy.yaml before
 * enqueuing). The CRUD API guards against typos by requiring the environment to
 * be declared or already configured at create time.
 *
 * `event` and `enabled` carry CHECKs. `UNIQUE(project, env, event, pattern)`
 * prevents duplicate identical triggers. Kept in its own const/file (not folded
 * into DEPLOYMENT_SCHEMA) so `deployment-trigger-schema.test.ts` can migrate an
 * in-memory DB in isolation and the Phase-2 schema test's table-set assertion is
 * unaffected. Imported by `db.ts` at boot and by the store's tests.
 */

export const DEPLOYMENT_ENV_TRIGGER_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_trigger (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name; matches a key in the project's deploy.yaml environments
    -- map WHILE that environment is declared. A trigger whose environment was
    -- removed from deploy.yaml is retained and simply never fires.
    environment_name TEXT NOT NULL,
    -- Git event that fires this trigger.
    event TEXT NOT NULL CHECK(event IN ('push', 'merge')),
    -- Glob matched against the updated branch name (see branchMatchesPattern).
    branch_pattern TEXT NOT NULL,
    -- Operator on/off switch. 1 = enabled (default). A disabled trigger is
    -- retained (a pause, not a delete) and never fires.
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    -- Free-form JSON stash for forward-compat.
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, environment_name, event, branch_pattern)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_trigger_project
    ON deployment_env_trigger(project_id);
  -- The hook evaluation path queries enabled triggers for a project + event.
  CREATE INDEX IF NOT EXISTS idx_deployment_env_trigger_event
    ON deployment_env_trigger(project_id, event, enabled);
`;
