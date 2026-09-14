/**
 * SQLite DDL for Experimental Project Autopilot.
 *
 * Persistent controller state (runs, cycles, stages, operations, events, leases).
 * Applied from db.ts at boot and from tests via ensureAutopilotSchema().
 */

export const AUTOPILOT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS autopilot_project_config (
    project_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL DEFAULT 0,
    disabling INTEGER NOT NULL DEFAULT 0,
    brief_id TEXT,
    target_id TEXT,
    target_json TEXT NOT NULL DEFAULT '{}',
    limits_json TEXT NOT NULL DEFAULT '{}',
    credential_owner_user_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS autopilot_briefs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    spec_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_by TEXT,
    UNIQUE(project_id, revision)
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_briefs_project
    ON autopilot_briefs(project_id, revision DESC);

  CREATE TABLE IF NOT EXISTS autopilot_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    control_state TEXT NOT NULL
      CHECK(control_state IN ('running', 'pausing', 'paused', 'stopping', 'stopped', 'failed')),
    stage TEXT
      CHECK(stage IS NULL OR stage IN (
        'planning', 'implementing', 'finalizing', 'deploying',
        'verifying', 'documenting', 'selecting-next'
      )),
    fencing_generation INTEGER NOT NULL DEFAULT 1,
    brief_id TEXT,
    brief_revision INTEGER,
    cycle_number INTEGER NOT NULL DEFAULT 0,
    pause_reason TEXT,
    failure_reason TEXT,
    last_verified_sha TEXT,
    last_deployment_id TEXT,
    credential_owner_user_id TEXT,
    target_id TEXT,
    limits_json TEXT NOT NULL DEFAULT '{}',
    usage_json TEXT NOT NULL DEFAULT '{}',
    started_by TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_runs_project
    ON autopilot_runs(project_id, started_at DESC);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_runs_one_active
    ON autopilot_runs(project_id)
    WHERE control_state IN ('running', 'pausing', 'paused', 'stopping');

  CREATE TABLE IF NOT EXISTS autopilot_leases (
    project_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    fencing_generation INTEGER NOT NULL,
    holder_id TEXT NOT NULL,
    leased_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES autopilot_runs(id)
  );

  CREATE TABLE IF NOT EXISTS autopilot_cycles (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    cycle_number INTEGER NOT NULL,
    brief_revision INTEGER NOT NULL,
    spec_revision INTEGER,
    card_id TEXT,
    session_id TEXT,
    tested_commit_sha TEXT,
    finalize_run_id TEXT,
    deployment_id TEXT,
    verification_json TEXT,
    documentation_json TEXT,
    selected_improvement TEXT,
    outcome TEXT,
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active', 'succeeded', 'failed', 'cancelled')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(run_id, cycle_number),
    FOREIGN KEY (run_id) REFERENCES autopilot_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_cycles_run
    ON autopilot_cycles(run_id, cycle_number DESC);

  CREATE TABLE IF NOT EXISTS autopilot_stages (
    id TEXT PRIMARY KEY,
    cycle_id TEXT NOT NULL,
    stage TEXT NOT NULL
      CHECK(stage IN (
        'planning', 'implementing', 'finalizing', 'deploying',
        'verifying', 'documenting', 'selecting-next'
      )),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending', 'in_progress', 'succeeded', 'failed', 'cancelled')),
    attempt INTEGER NOT NULL DEFAULT 1,
    operation_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    result_json TEXT,
    UNIQUE(cycle_id, stage, attempt),
    FOREIGN KEY (cycle_id) REFERENCES autopilot_cycles(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_stages_cycle
    ON autopilot_stages(cycle_id, attempt);

  CREATE TABLE IF NOT EXISTS autopilot_operations (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    cycle_id TEXT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL
      CHECK(status IN ('pending', 'in_flight', 'succeeded', 'failed', 'cancelled', 'ambiguous')),
    fencing_generation INTEGER NOT NULL,
    intent_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT,
    session_id TEXT,
    finalize_run_id TEXT,
    deployment_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (run_id) REFERENCES autopilot_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_autopilot_operations_run
    ON autopilot_operations(run_id, status);
  CREATE INDEX IF NOT EXISTS idx_autopilot_operations_cycle
    ON autopilot_operations(cycle_id);

  CREATE TABLE IF NOT EXISTS autopilot_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    cycle_id TEXT,
    operation_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    fencing_generation INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    seq INTEGER NOT NULL,
    FOREIGN KEY (run_id) REFERENCES autopilot_runs(id) ON DELETE CASCADE
  );
`;

export function ensureAutopilotSchema(db: { exec: (sql: string) => unknown }): void {
  db.exec(AUTOPILOT_SCHEMA);
  try {
    db.exec('ALTER TABLE autopilot_project_config ADD COLUMN disabling INTEGER NOT NULL DEFAULT 0');
  } catch {
    /* column already present */
  }
  try {
    db.exec('ALTER TABLE autopilot_events ADD COLUMN seq INTEGER');
  } catch {
    /* column already present */
  }
  db.exec(`
    UPDATE autopilot_events
    SET seq = rowid
    WHERE seq IS NULL
  `);
  db.exec(`DROP INDEX IF EXISTS idx_autopilot_events_run`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_autopilot_events_seq ON autopilot_events(seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_autopilot_events_run ON autopilot_events(run_id, seq)`);
}
