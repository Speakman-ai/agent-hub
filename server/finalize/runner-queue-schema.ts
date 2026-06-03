/**
 * runner-queue-schema.ts — DDL for the multi-tenant Finalize runner control plane.
 *
 * Lives in the shared cross-org `orgs.db` (the only store that spans orgs), NOT a
 * per-org `agent-hub.db`: one runner fleet serves every tenant, so the queue is
 * inherently cross-org. Per-org `agent-hub.db` keeps owning the UI-facing run
 * state (`finalize_runs`/`finalize_run_steps`/`finalize_run_jobs`); this queue is
 * a routing/lease layer the remote backend writes results back from.
 *
 * Pure leaf module (no imports) so `orgs.ts` can apply it without an import cycle.
 */
export const RUNNER_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS runner_jobs (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  job_id           TEXT NOT NULL,
  matrix_key       TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL,            -- queued|claimed|running|succeeded|failed|cancelled|lost
  image            TEXT NOT NULL,
  runner_class     TEXT NOT NULL DEFAULT 'default',
  org_scope        TEXT NOT NULL DEFAULT 'shared',  -- 'shared' (any agent) or a specific org_id
  priority         INTEGER NOT NULL DEFAULT 0,
  spec_json        TEXT NOT NULL,            -- JobClaimSpec sans secrets
  secrets_ref      TEXT,                     -- SSM/Secrets Manager ARN, or null
  claimed_by       TEXT,                     -- agent id
  lease_expires_at INTEGER,                  -- visibility-timeout deadline (epoch ms)
  heartbeat_at     INTEGER,
  attempt          INTEGER NOT NULL DEFAULT 0,
  exit_code        INTEGER,
  detail           TEXT,                     -- terminal reason (infra_error msg, etc.)
  enqueued_at      INTEGER NOT NULL,
  claimed_at       INTEGER,
  ended_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_claimable
  ON runner_jobs(state, runner_class, priority, enqueued_at);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_lease ON runner_jobs(state, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_runner_jobs_run ON runner_jobs(org_id, run_id);

CREATE TABLE IF NOT EXISTS runner_agents (
  id             TEXT PRIMARY KEY,
  org_scope      TEXT NOT NULL,              -- 'shared' or a specific org_id
  state          TEXT NOT NULL,             -- idle|busy|draining|dead
  current_job_id TEXT,
  ecs_task_arn   TEXT,
  registered_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL
);

-- Append-only durable log spool: survives a Hub restart mid-stream and lets the
-- UI replay. Keyed by (job_id, seq) so reconnect/resume can dedupe.
CREATE TABLE IF NOT EXISTS runner_job_logs (
  job_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  stream     TEXT NOT NULL,                  -- stdout|stderr
  data       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
);
`;

/** Terminal job states (a run leaving any of these needs no further work). */
export const RUNNER_JOB_TERMINAL_STATES = ['succeeded', 'failed', 'cancelled', 'lost'] as const;
export type RunnerJobState =
  | 'queued'
  | 'claimed'
  | 'running'
  | (typeof RUNNER_JOB_TERMINAL_STATES)[number];
