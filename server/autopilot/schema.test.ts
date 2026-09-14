import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { AUTOPILOT_SCHEMA, ensureAutopilotSchema } from './schema.js';

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  pk: number;
};

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(AUTOPILOT_SCHEMA);
  return db;
}

describe('autopilot schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates run, cycle, stage, operation, event and lease tables', () => {
    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'autopilot_project_config',
        'autopilot_briefs',
        'autopilot_runs',
        'autopilot_leases',
        'autopilot_cycles',
        'autopilot_stages',
        'autopilot_operations',
        'autopilot_events',
      ]),
    );
  });

  it('enforces one active run per project', () => {
    const insert = db.prepare(
      `INSERT INTO autopilot_runs (id, project_id, control_state, stage, fencing_generation, cycle_number)
       VALUES (?, 'proj', ?, 'planning', 1, 1)`,
    );
    insert.run('run-1', 'running');
    expect(() => insert.run('run-2', 'running')).toThrow(/UNIQUE/i);
    insert.run('run-3', 'stopped');
    expect(
      (db.pragma('index_list(autopilot_runs)') as { name: string }[]).map((i) => i.name),
    ).toContain('idx_autopilot_runs_one_active');
  });

  it('stores fencing generation and operation ids', () => {
    db.exec(
      `INSERT INTO autopilot_runs (id, project_id, control_state, fencing_generation, cycle_number)
       VALUES ('run-1', 'proj', 'running', 4, 1)`,
    );
    db.exec(
      `INSERT INTO autopilot_operations (id, run_id, kind, status, fencing_generation)
       VALUES ('op-1', 'run-1', 'deploy', 'in_flight', 4)`,
    );
    const cols = (db.pragma('table_info(autopilot_operations)') as TableInfoRow[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'run_id',
        'fencing_generation',
        'intent_json',
        'session_id',
        'finalize_run_id',
        'deployment_id',
      ]),
    );
  });

  it('stores a disabling fence on project config', () => {
    const cols = (db.pragma('table_info(autopilot_project_config)') as TableInfoRow[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('disabling');
  });

  it('stores a monotonic event sequence', () => {
    ensureAutopilotSchema(db);
    const cols = (db.pragma('table_info(autopilot_events)') as TableInfoRow[]).map((c) => c.name);
    expect(cols).toContain('seq');
    expect(
      (db.pragma('index_list(autopilot_events)') as { name: string }[]).map((i) => i.name),
    ).toContain('idx_autopilot_events_seq');
  });

  it('backfills seq on a pre-sequence event journal', () => {
    const legacy = new Database(':memory:');
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      CREATE TABLE autopilot_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        cycle_id TEXT,
        operation_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        fencing_generation INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_autopilot_events_run ON autopilot_events(run_id, created_at);
      INSERT INTO autopilot_events (id, run_id, type, created_at) VALUES
        ('z', 'run-1', 'first', '2026-09-14 05:31:00'),
        ('a', 'run-1', 'second', '2026-09-14 05:31:00');
    `);
    ensureAutopilotSchema(legacy);
    const rows = legacy.prepare(`SELECT id, seq FROM autopilot_events ORDER BY seq ASC`).all() as {
      id: string;
      seq: number;
    }[];
    expect(rows.map((row) => row.seq)).toEqual([1, 2]);
    expect(rows.map((row) => row.id)).toEqual(['z', 'a']);
  });
});
