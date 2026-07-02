/**
 * SQLite DDL for per-environment DEPLOY SCHEDULES (multi-environment management —
 * the scheduling phase on top of the `environments-config` runtime-config layer).
 *
 * Locked epic decision `deploy-scheduling`:
 *   A schedule is a DB row `{environment, ref, cron, timezone, owner_user_id,
 *   enabled}`. It reuses the node-cron + owner + timezone pattern from
 *   crons/heartbeats and runs under the owner identity. A disabled schedule is
 *   retained (a temporary pause, not a delete). A firing schedule enqueues a
 *   deployment with `trigger=schedule` for the mapped environment, honoring the
 *   per-env concurrency lock. There is NO deploy.yaml schedule block — schedules
 *   are operator-editable without a commit, keyed by (project_id,
 *   environment_name) exactly like the runtime config + triggers stores.
 *
 * This card owns only the STORE + CRUD API. The node-cron registration / firing
 * path that consumes these rows to enqueue deployments is a sibling card that
 * reads {@link listEnabledSchedules} from the store.
 *
 *   - `deployment_env_schedule` — zero-or-more rows per (project, environment).
 *     `ref` is the git ref (branch/tag/sha) the schedule deploys. `cron` is a
 *     node-cron expression validated at the write boundary. `timezone` is a
 *     nullable IANA timezone used to interpret the cron (null = server default,
 *     matching crons/heartbeats). `owner_user_id` is the identity the scheduled
 *     run spawns under (nullable = system-owned/legacy). `enabled` is the
 *     operator on/off switch (a disabled schedule is retained, not deleted).
 *     `meta` is a nullable JSON stash for forward-compat.
 *
 * Like the runtime-config + triggers tables this intentionally does NOT enforce
 * that `environment_name` matches a current deploy.yaml environment: deploy.yaml
 * is edited out-of-band, so a schedule whose environment was removed is retained
 * and simply never fires (the firing path resolves deployability against
 * deploy.yaml before enqueuing). The CRUD API guards against typos by requiring
 * the environment to be declared or already configured at create time.
 *
 * `enabled` carries a CHECK. `UNIQUE(project, env, ref, cron)` prevents duplicate
 * identical schedules. Kept in its own const/file (not folded into
 * DEPLOYMENT_SCHEMA) so `deployment-schedule-schema.test.ts` can migrate an
 * in-memory DB in isolation and the Phase-2 schema test's table-set assertion is
 * unaffected. Imported by `db.ts` at boot and by the store's tests.
 */

export const DEPLOYMENT_ENV_SCHEDULE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_schedule (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name; matches a key in the project's deploy.yaml environments
    -- map WHILE that environment is declared. A schedule whose environment was
    -- removed from deploy.yaml is retained and simply never fires.
    environment_name TEXT NOT NULL,
    -- Git ref (branch / tag / sha) the schedule deploys.
    ref TEXT NOT NULL,
    -- node-cron expression (validated at the write boundary).
    cron TEXT NOT NULL,
    -- Optional IANA timezone used to interpret the cron expression. NULL falls
    -- back to the server scheduler timezone (matches crons/heartbeats).
    timezone TEXT,
    -- Identity the scheduled run spawns under. NULL = system-owned / legacy.
    owner_user_id TEXT,
    -- Operator on/off switch. 1 = enabled (default). A disabled schedule is
    -- retained (a pause, not a delete) and never fires.
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    -- Free-form JSON stash for forward-compat.
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (project_id, environment_name, ref, cron)
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_schedule_project
    ON deployment_env_schedule(project_id);
  -- The scheduler registration path queries enabled schedules across projects.
  CREATE INDEX IF NOT EXISTS idx_deployment_env_schedule_enabled
    ON deployment_env_schedule(enabled);
`;
