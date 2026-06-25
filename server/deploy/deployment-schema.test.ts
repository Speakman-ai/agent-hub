/**
 * Deployment Module DDL — table shape, FK wiring, indexes, CHECK constraints,
 * and migration idempotency (in-memory SQLite, no app bootstrap).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEPLOYMENT_SCHEMA } from './deployment-schema.js';

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
  db.exec(DEPLOYMENT_SCHEMA);
  return db;
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

function namedIdx(db: Database.Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
  return rows
    .map((r) => r.name)
    .filter((n) => n.startsWith('idx_'))
    .sort();
}

describe('deployment schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates all four deployment tables', () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'deployment%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(
      ['deployment_approvals', 'deployment_environments', 'deployment_steps', 'deployments'].sort(),
    );
  });

  it('defines deployments columns including ref, trigger, and rollback source', () => {
    expect(colNames(db, 'deployments')).toEqual(
      [
        'id',
        'project_id',
        'environment',
        'ref',
        'status',
        'trigger',
        'triggered_by',
        'source_deployment_id',
        'runner_job_id',
        'error',
        'meta',
        'created_at',
        'started_at',
        'completed_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults deployments.status to pending and trigger to manual', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d1', 'p1', 'dev', 'abc')",
    ).run();
    const row = db.prepare('SELECT status, trigger FROM deployments WHERE id = ?').get('d1') as {
      status: string;
      trigger: string;
    };
    expect(row.status).toBe('pending');
    expect(row.trigger).toBe('manual');
  });

  it('rejects an out-of-set deployments.status via CHECK', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployments (id, project_id, environment, ref, status) VALUES ('d2','p1','dev','abc','bogus')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('does NOT constrain trigger (new sources without a CHECK migration)', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployments (id, project_id, environment, ref, trigger) VALUES ('d3','p1','dev','abc','schedule')",
        )
        .run(),
    ).not.toThrow();
  });

  it('cascades step + approval deletes when a deployment is removed', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d4','p1','dev','abc')",
    ).run();
    db.prepare(
      "INSERT INTO deployment_steps (id, deployment_id, name, step_order) VALUES ('s1','d4','build',0)",
    ).run();
    db.prepare(
      "INSERT INTO deployment_approvals (id, deployment_id, approver_user_id, approver_role) VALUES ('a1','d4','u1','Admin')",
    ).run();

    db.prepare("DELETE FROM deployments WHERE id = 'd4'").run();

    expect(db.prepare('SELECT COUNT(*) c FROM deployment_steps').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_approvals').get()).toMatchObject({ c: 0 });
  });

  it('enforces UNIQUE(project_id, name) on deployment_environments', () => {
    db.prepare(
      "INSERT INTO deployment_environments (id, project_id, name) VALUES ('e1','p1','prod')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_environments (id, project_id, name) VALUES ('e2','p1','prod')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    // Same name under a different project is allowed.
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_environments (id, project_id, name) VALUES ('e3','p2','prod')",
        )
        .run(),
    ).not.toThrow();
  });

  it('constrains deployment_steps.status and deployment_approvals.decision', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d5','p1','dev','abc')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_steps (id, deployment_id, name, step_order, status) VALUES ('s9','d5','x',0,'nope')",
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_approvals (id, deployment_id, approver_user_id, approver_role, decision) VALUES ('a9','d5','u','Admin','maybe')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('creates the expected named indexes', () => {
    expect(namedIdx(db, 'deployments')).toEqual(
      ['idx_deployments_env_created', 'idx_deployments_project_created'].sort(),
    );
    expect(namedIdx(db, 'deployment_steps')).toEqual(['idx_deployment_steps_deployment']);
    expect(namedIdx(db, 'deployment_environments')).toEqual([
      'idx_deployment_environments_project',
    ]);
    expect(namedIdx(db, 'deployment_approvals')).toEqual(['idx_deployment_approvals_deployment']);
  });

  it('is idempotent — re-running the DDL is a no-op (CREATE ... IF NOT EXISTS)', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('keep','p1','dev','abc')",
    ).run();
    expect(() => db.exec(DEPLOYMENT_SCHEMA)).not.toThrow();
    // Existing data survives a second migration pass.
    expect(db.prepare('SELECT COUNT(*) c FROM deployments').get()).toMatchObject({ c: 1 });
  });
});
