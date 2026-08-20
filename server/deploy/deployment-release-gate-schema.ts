/**
 * SQLite DDL for per-environment RELEASE GATES (multi-environment management —
 * the release-gate phase on top of the `environments-config` runtime-config
 * layer). Sibling to the git-event TRIGGERS and cron SCHEDULES stores.
 *
 * A release gate is a ONE-SHOT automated deploy: it fires a single deployment
 * once a curated set of sessions AND/OR epics are all complete, then is
 * consumed (status flips `armed` → `fired`). This differs from the recurring
 * triggers (fire on every matching push) and schedules (fire on every cron
 * tick).
 *
 *   A gate is a DB row `{environment, ref, session_ids[], epic_ids[],
 *   owner_user_id, status, enabled}`. "Complete" means:
 *     - session  → its linked kanban card sits in a Done column (a PR merged to
 *       main), the same signal `session-state.ts` resolves.
 *     - epic     → every non-cancelled card is Done (`computeEpicState === 'done'`).
 *   The condition is an AND across everything selected; an empty side is
 *   satisfied (a sessions-only or epics-only gate is allowed, but a gate with
 *   neither is rejected at the write boundary). A selected session/epic that no
 *   longer exists can never be satisfied, so the gate stays armed and never
 *   fires ("default to block") until the operator removes it.
 *
 *   Firing enqueues one deployment with `trigger=release_gate` for the mapped
 *   environment, honoring the per-env concurrency lock, under the owner's
 *   identity. On success the row flips to `fired` (with `fired_deployment_id`);
 *   an enqueue failure flips it to `failed` (with `last_error`). A gate remains
 *   until it is deleted or released (fired) — it is never auto-cleaned.
 *
 * Like the sibling runtime-config / trigger / schedule tables this intentionally
 * does NOT enforce that `environment_name` matches a current deploy.yaml
 * environment: deploy.yaml is edited out-of-band, so a gate whose environment
 * was removed is retained and simply never fires (the firing path resolves
 * deployability against deploy.yaml before enqueuing). The CRUD API guards
 * against typos by requiring the environment to be declared or already
 * configured at create time.
 *
 * `session_ids` / `epic_ids` are JSON arrays of id strings (the multi-select the
 * operator curated). `status` and `enabled` carry CHECKs. Kept in its own
 * const/file (not folded into DEPLOYMENT_SCHEMA) so
 * `deployment-release-gate-schema.test.ts` can migrate an in-memory DB in
 * isolation and the Phase-2 schema test's table-set assertion is unaffected.
 * Imported by `db.ts` at boot and by the store's tests for hermetic checks.
 */

export const DEPLOYMENT_ENV_RELEASE_GATE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS deployment_env_release_gate (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    -- Environment name; matches a key in the project's deploy.yaml environments
    -- map WHILE that environment is declared. A gate whose environment was
    -- removed from deploy.yaml is retained and simply never fires.
    environment_name TEXT NOT NULL,
    -- Git ref (branch / tag / sha) the gate deploys when it fires. Defaults to
    -- 'main' at the write boundary unless the operator overrides it.
    ref TEXT NOT NULL,
    -- JSON array of session ids that must be merged before the gate fires.
    session_ids TEXT NOT NULL DEFAULT '[]',
    -- JSON array of epic ids that must be done before the gate fires.
    epic_ids TEXT NOT NULL DEFAULT '[]',
    -- Identity the fired deployment spawns under. NULL = system-owned / legacy.
    owner_user_id TEXT,
    -- Lifecycle: armed (waiting on its conditions), fired (released — the
    -- deployment was enqueued), failed (the enqueue threw). A fired/failed gate
    -- is terminal and never re-evaluated.
    status TEXT NOT NULL DEFAULT 'armed' CHECK(status IN ('armed', 'fired', 'failed')),
    -- Operator on/off switch. 1 = enabled (default). A disabled gate is retained
    -- (a pause, not a delete) and never fires while paused.
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
    -- Set when the gate fires: the deployment row it enqueued.
    fired_deployment_id TEXT,
    -- Set when the gate's fire attempt failed: the enqueue error message.
    last_error TEXT,
    -- Timestamp the gate reached a terminal (fired/failed) status.
    resolved_at TEXT,
    -- Free-form JSON stash for forward-compat.
    meta TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_deployment_env_release_gate_project
    ON deployment_env_release_gate(project_id);
  -- The sweep evaluates every armed + enabled gate across projects.
  CREATE INDEX IF NOT EXISTS idx_deployment_env_release_gate_active
    ON deployment_env_release_gate(status, enabled);
`;
