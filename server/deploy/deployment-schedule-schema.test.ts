/**
 * Per-environment deploy schedule DDL — table shape, UNIQUE key, defaults, CHECK
 * constraints, indexes, and migration idempotency (in-memory SQLite, no app
 * bootstrap).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEPLOYMENT_ENV_SCHEDULE_SCHEMA } from './deployment-schedule-schema.js';

type TableInfoRow = { name: string };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(DEPLOYMENT_ENV_SCHEDULE_SCHEMA);
  return db;
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

function insert(db: Database.Database, cols: Record<string, string | number>): void {
  const keys = Object.keys(cols);
  db.prepare(
    `INSERT INTO deployment_env_schedule (${keys.join(', ')}) VALUES (${keys
      .map((k) => `@${k}`)
      .join(', ')})`,
  ).run(cols);
}

describe('deployment env schedule schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates the deployment_env_schedule table with the expected columns', () => {
    expect(colNames(db, 'deployment_env_schedule')).toEqual(
      [
        'id',
        'project_id',
        'environment_name',
        'ref',
        'cron',
        'timezone',
        'owner_user_id',
        'enabled',
        'meta',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults enabled to 1 (a fresh schedule is on)', () => {
    insert(db, {
      id: 's1',
      project_id: 'p1',
      environment_name: 'prod',
      ref: 'main',
      cron: '0 3 * * *',
    });
    const row = db
      .prepare('SELECT enabled FROM deployment_env_schedule WHERE id = ?')
      .get('s1') as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('allows null timezone and owner_user_id', () => {
    insert(db, {
      id: 's2',
      project_id: 'p1',
      environment_name: 'prod',
      ref: 'main',
      cron: '0 3 * * *',
    });
    const row = db
      .prepare('SELECT timezone, owner_user_id FROM deployment_env_schedule WHERE id = ?')
      .get('s2') as { timezone: string | null; owner_user_id: string | null };
    expect(row.timezone).toBeNull();
    expect(row.owner_user_id).toBeNull();
  });

  it('constrains enabled to 0/1 via CHECK', () => {
    expect(() =>
      insert(db, {
        id: 's3',
        project_id: 'p1',
        environment_name: 'prod',
        ref: 'main',
        cron: '0 3 * * *',
        enabled: 2,
      }),
    ).toThrow(/CHECK/i);
  });

  it('enforces UNIQUE(project_id, environment_name, ref, cron)', () => {
    insert(db, {
      id: 'u1',
      project_id: 'p1',
      environment_name: 'prod',
      ref: 'main',
      cron: '0 3 * * *',
    });
    // Same tuple -> collision.
    expect(() =>
      insert(db, {
        id: 'u2',
        project_id: 'p1',
        environment_name: 'prod',
        ref: 'main',
        cron: '0 3 * * *',
      }),
    ).toThrow(/UNIQUE/i);
    // Different ref, cron, or environment is allowed.
    expect(() =>
      insert(db, {
        id: 'u3',
        project_id: 'p1',
        environment_name: 'prod',
        ref: 'release',
        cron: '0 3 * * *',
      }),
    ).not.toThrow();
    expect(() =>
      insert(db, {
        id: 'u4',
        project_id: 'p1',
        environment_name: 'prod',
        ref: 'main',
        cron: '0 4 * * *',
      }),
    ).not.toThrow();
  });

  it('creates the project and enabled indexes', () => {
    const idx = (
      db.prepare('PRAGMA index_list(deployment_env_schedule)').all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => n.startsWith('idx_'));
    expect(idx).toContain('idx_deployment_env_schedule_project');
    expect(idx).toContain('idx_deployment_env_schedule_enabled');
  });

  it('is idempotent — re-running the DDL preserves existing rows', () => {
    insert(db, {
      id: 'keep',
      project_id: 'p1',
      environment_name: 'prod',
      ref: 'main',
      cron: '0 3 * * *',
    });
    expect(() => db.exec(DEPLOYMENT_ENV_SCHEDULE_SCHEMA)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_env_schedule').get()).toMatchObject({
      c: 1,
    });
  });
});
