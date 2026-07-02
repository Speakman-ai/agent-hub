/**
 * Per-environment notification routing DDL — table shape, UNIQUE key, defaults,
 * CHECK constraints, index, and migration idempotency (in-memory SQLite, no app
 * bootstrap).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA } from './deployment-notification-routing-schema.js';

type TableInfoRow = { name: string };

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA);
  return db;
}

function colNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as TableInfoRow[]).map((c) => c.name).sort();
}

describe('deployment env notification routing schema', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates the deployment_env_notification_routing table with the expected columns', () => {
    expect(colNames(db, 'deployment_env_notification_routing')).toEqual(
      [
        'id',
        'project_id',
        'environment_name',
        'ticket_release_enabled',
        'release_digest_enabled',
        'meta',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defaults both notification-type switches to 0 (a fresh row opts in nothing)', () => {
    db.prepare(
      "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name) VALUES ('r1','p1','dev')",
    ).run();
    const row = db
      .prepare(
        'SELECT ticket_release_enabled, release_digest_enabled FROM deployment_env_notification_routing WHERE id = ?',
      )
      .get('r1') as { ticket_release_enabled: number; release_digest_enabled: number };
    expect(row.ticket_release_enabled).toBe(0);
    expect(row.release_digest_enabled).toBe(0);
  });

  it('constrains the type switches to 0/1 via CHECK', () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name, ticket_release_enabled) VALUES ('r2','p1','dev',2)",
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name, release_digest_enabled) VALUES ('r3','p1','dev',5)",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('enforces UNIQUE(project_id, environment_name)', () => {
    db.prepare(
      "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name) VALUES ('e1','p1','prod')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name) VALUES ('e2','p1','prod')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
    // Same environment name under a different project is allowed.
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name) VALUES ('e3','p2','prod')",
        )
        .run(),
    ).not.toThrow();
  });

  it('creates the project index', () => {
    const idx = (
      db.prepare('PRAGMA index_list(deployment_env_notification_routing)').all() as {
        name: string;
      }[]
    )
      .map((r) => r.name)
      .filter((n) => n.startsWith('idx_'));
    expect(idx).toContain('idx_deployment_env_notification_routing_project');
  });

  it('is idempotent — re-running the DDL preserves existing rows', () => {
    db.prepare(
      "INSERT INTO deployment_env_notification_routing (id, project_id, environment_name, ticket_release_enabled) VALUES ('keep','p1','dev',1)",
    ).run();
    expect(() => db.exec(DEPLOYMENT_ENV_NOTIFICATION_ROUTING_SCHEMA)).not.toThrow();
    expect(
      db.prepare('SELECT COUNT(*) c FROM deployment_env_notification_routing').get(),
    ).toMatchObject({ c: 1 });
  });
});
