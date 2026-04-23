/**
 * Workflow tables DDL — shape, FK wiring, and indexes (in-memory SQLite).
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { WORKFLOWS_SCHEMA } from './workflows-schema.js';

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(WORKFLOWS_SCHEMA);
  return db;
}

function indexNames(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name).sort();
}

/** Named indexes only (SQLite also lists sqlite_autoindex_* for PK/UNIQUE). */
function namedIdx(db: Database.Database, table: string): string[] {
  return indexNames(db, table).filter((n) => n.startsWith('idx_'));
}

describe('workflows schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('defines workflows with trigger_type and default_payload', () => {
    const cols = db.pragma('table_info(workflows)') as TableInfoRow[];
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'created_at',
        'cron_expr',
        'cron_next_run_at',
        'default_payload',
        'id',
        'name',
        'project_id',
        'trigger_column_id',
        'trigger_type',
        'updated_at',
        'webhook_path_token',
        'webhook_signing_secret',
      ].sort(),
    );
    const trig = cols.find((c) => c.name === 'trigger_type');
    expect(trig?.dflt_value).toMatch(/manual/i);
  });

  it('indexes workflows.project_id', () => {
    expect(indexNames(db, 'workflows')).toContain('idx_workflows_project');
  });

  it('defines workflow_steps with order, timeout, on_failure, condition stub, parallel_group', () => {
    const cols = db.pragma('table_info(workflow_steps)') as TableInfoRow[];
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName.step_order?.notnull).toBe(1);
    expect(byName.timeout_ms?.notnull).toBe(0);
    expect(byName.condition_expr?.notnull).toBe(0);
    expect(byName.parallel_group?.notnull).toBe(0);
    expect(byName.on_failure?.dflt_value?.toLowerCase()).toContain('abort');
    expect(namedIdx(db, 'workflow_steps')).toEqual(
      ['idx_workflow_steps_workflow', 'idx_workflow_steps_workflow_order'].sort(),
    );
  });

  it('defines workflow_runs and workflow_step_runs with FK indexes', () => {
    expect(namedIdx(db, 'workflow_runs').sort()).toEqual(
      ['idx_workflow_runs_status', 'idx_workflow_runs_workflow'].sort(),
    );
    expect(namedIdx(db, 'workflow_step_runs').sort()).toEqual(
      ['idx_workflow_step_runs_run', 'idx_workflow_step_runs_step'].sort(),
    );
    expect(
      indexNames(db, 'workflow_step_runs').some((n) => n.startsWith('sqlite_autoindex_')),
    ).toBe(true);
  });

  it('rejects orphan workflow_steps', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_steps (id, workflow_id, agent_id, title, role_prompt, step_order)
           VALUES ('s1', 'missing', 'a1', 't', 'rp', 0)`,
        )
        .run(),
    ).toThrow();
  });

  it('cascades deletes from workflows to steps, runs, and step_runs', () => {
    db.prepare(
      `INSERT INTO workflows (id, project_id, name, default_payload) VALUES ('w1', 'p1', 'n', '{"x":1}')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_id, agent_id, title, role_prompt, step_order)
       VALUES ('st1', 'w1', 'agent-x', 'Step', 'Do thing', 0)`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_runs (id, workflow_id, status) VALUES ('r1', 'w1', 'running')`,
    ).run();
    db.prepare(
      `INSERT INTO workflow_step_runs (id, workflow_run_id, workflow_step_id, status)
       VALUES ('sr1', 'r1', 'st1', 'pending')`,
    ).run();

    db.prepare('DELETE FROM workflows WHERE id = ?').run('w1');

    expect((db.prepare('SELECT COUNT(*) as c FROM workflow_steps').get() as { c: number }).c).toBe(
      0,
    );
    expect((db.prepare('SELECT COUNT(*) as c FROM workflow_runs').get() as { c: number }).c).toBe(
      0,
    );
    expect(
      (db.prepare('SELECT COUNT(*) as c FROM workflow_step_runs').get() as { c: number }).c,
    ).toBe(0);
  });

  it('enforces unique (workflow_run_id, workflow_step_id)', () => {
    db.prepare(`INSERT INTO workflows (id, project_id, name) VALUES ('w1', 'p1', 'n')`).run();
    db.prepare(
      `INSERT INTO workflow_steps (id, workflow_id, agent_id, title, role_prompt, step_order)
       VALUES ('st1', 'w1', 'a', 't', 'rp', 0)`,
    ).run();
    db.prepare(`INSERT INTO workflow_runs (id, workflow_id) VALUES ('r1', 'w1')`).run();
    db.prepare(
      `INSERT INTO workflow_step_runs (id, workflow_run_id, workflow_step_id) VALUES ('sr1', 'r1', 'st1')`,
    ).run();

    expect(() =>
      db
        .prepare(
          `INSERT INTO workflow_step_runs (id, workflow_run_id, workflow_step_id) VALUES ('sr2', 'r1', 'st1')`,
        )
        .run(),
    ).toThrow();
  });
});
