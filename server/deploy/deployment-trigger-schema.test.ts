/**
 * Per-environment deploy trigger DDL — table shape, UNIQUE key, defaults, CHECK
 * constraints, indexes, and migration idempotency (in-memory SQLite, no app
 * bootstrap).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEPLOYMENT_ENV_TRIGGER_SCHEMA } from './deployment-trigger-schema.js';

type TableInfoRow = { name: string };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(DEPLOYMENT_ENV_TRIGGER_SCHEMA);
  return db;
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

function insert(db: Database.Database, cols: Record<string, string | number>): void {
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO deployment_env_trigger (${keys.join(', ')}) VALUES (${keys
      .map((k) => `@${k}`)
      .join(', ')})`,
  ).run(cols);
}

describe('deployment env trigger schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates the deployment_env_trigger table with the expected columns', () => {
    expect(colNames(db, 'deployment_env_trigger')).toEqual(
      [
        'id',
        'project_id',
        'environment_name',
        'event',
        'branch_pattern',
        'enabled',
        'meta',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults enabled to 1 (a fresh trigger is on)', () => {
    insert(db, {
      id: 't1',
      project_id: 'p1',
      environment_name: 'prod',
      event: 'push',
      branch_pattern: 'main',
    });
    const row = db.prepare('SELECT enabled FROM deployment_env_trigger WHERE id = ?').get('t1') as {
      enabled: number;
    };
    expect(row.enabled).toBe(1);
  });

  it('constrains event to push/merge via CHECK', () => {
    expect(() =>
      insert(db, {
        id: 't2',
        project_id: 'p1',
        environment_name: 'prod',
        event: 'tag',
        branch_pattern: 'main',
      }),
    ).toThrow(/CHECK/i);
  });

  it('constrains enabled to 0/1 via CHECK', () => {
    expect(() =>
      insert(db, {
        id: 't3',
        project_id: 'p1',
        environment_name: 'prod',
        event: 'push',
        branch_pattern: 'main',
        enabled: 2,
      }),
    ).toThrow(/CHECK/i);
  });

  it('enforces UNIQUE(project_id, environment_name, event, branch_pattern)', () => {
    insert(db, {
      id: 'u1',
      project_id: 'p1',
      environment_name: 'prod',
      event: 'push',
      branch_pattern: 'main',
    });
    // Same tuple -> collision.
    expect(() =>
      insert(db, {
        id: 'u2',
        project_id: 'p1',
        environment_name: 'prod',
        event: 'push',
        branch_pattern: 'main',
      }),
    ).toThrow(/UNIQUE/i);
    // Different event, or pattern, or environment is allowed.
    expect(() =>
      insert(db, {
        id: 'u3',
        project_id: 'p1',
        environment_name: 'prod',
        event: 'merge',
        branch_pattern: 'main',
      }),
    ).not.toThrow();
    expect(() =>
      insert(db, {
        id: 'u4',
        project_id: 'p1',
        environment_name: 'prod',
        event: 'push',
        branch_pattern: 'release/*',
      }),
    ).not.toThrow();
  });

  it('creates the project and event indexes', () => {
    const idx = (
      db.prepare('PRAGMA index_list(deployment_env_trigger)').all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => n.startsWith('idx_'));
    expect(idx).toContain('idx_deployment_env_trigger_project');
    expect(idx).toContain('idx_deployment_env_trigger_event');
  });

  it('is idempotent — re-running the DDL preserves existing rows', () => {
    insert(db, {
      id: 'keep',
      project_id: 'p1',
      environment_name: 'prod',
      event: 'push',
      branch_pattern: 'main',
    });
    expect(() => db.exec(DEPLOYMENT_ENV_TRIGGER_SCHEMA)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_env_trigger').get()).toMatchObject({
      c: 1,
    });
  });
});
