/**
 * Per-environment runtime config DDL — table shape, UNIQUE key, defaults, CHECK,
 * index, and migration idempotency (in-memory SQLite, no app bootstrap).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA } from './deployment-env-config-schema.js';

type TableInfoRow = { name: string };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA);
  return db;
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

describe('deployment env runtime config schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates the deployment_env_runtime_config table with the expected columns', () => {
    expect(colNames(db, 'deployment_env_runtime_config')).toEqual(
      [
        'id',
        'project_id',
        'environment_name',
        'enabled',
        'meta',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults enabled to 1 (a fresh environment config is on)', () => {
    db.prepare(
      "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name) VALUES ('c1','p1','dev')",
    ).run();
    const row = db
      .prepare('SELECT enabled FROM deployment_env_runtime_config WHERE id = ?')
      .get('c1') as { enabled: number };
    expect(row.enabled).toBe(1);
  });

  it('constrains enabled to 0/1 via CHECK', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name, enabled) VALUES ('c2','p1','dev',2)",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('enforces UNIQUE(project_id, environment_name)', () => {
    db.prepare(
      "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name) VALUES ('e1','p1','prod')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name) VALUES ('e2','p1','prod')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    // Same environment name under a different project is allowed.
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name) VALUES ('e3','p2','prod')",
        )
        .run(),
    ).not.toThrow();
  });

  it('creates the project index', () => {
    const idx = (
      db.prepare('PRAGMA index_list(deployment_env_runtime_config)').all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((n) => n.startsWith('idx_'));
    expect(idx).toContain('idx_deployment_env_runtime_config_project');
  });

  it('is idempotent — re-running the DDL preserves existing rows', () => {
    db.prepare(
      "INSERT INTO deployment_env_runtime_config (id, project_id, environment_name, enabled) VALUES ('keep','p1','dev',0)",
    ).run();
    expect(() => db.exec(DEPLOYMENT_ENV_RUNTIME_CONFIG_SCHEMA)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_env_runtime_config').get()).toMatchObject({
      c: 1,
    });
  });
});
