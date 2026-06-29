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

  it('creates deployment and release notification tables', () => {
    const tables = (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE type='table'
              AND (name LIKE 'deployment%' OR name = 'release_notification_outbox')`,
        )
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    expect(tables).toEqual(
      [
        'deployment_approvals',
        'deployment_environments',
        'deployment_release_items',
        'deployment_steps',
        'deployments',
        'release_notification_outbox',
      ].sort(),
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

  it('defines deployment_release_items columns for auditable release inclusion', () => {
    expect(colNames(db, 'deployment_release_items')).toEqual(
      [
        'id',
        'deployment_id',
        'card_id',
        'support_ticket_id',
        'source',
        'inclusion_status',
        'operator_adjusted_by',
        'operator_adjustment_note',
        'operator_adjustment_meta',
        'operator_adjusted_at',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('defines release notification outbox columns for retryable email delivery', () => {
    expect(colNames(db, 'release_notification_outbox')).toEqual(
      [
        'id',
        'project_id',
        'deployment_id',
        'release_item_id',
        'support_ticket_id',
        'notification_type',
        'idempotency_key',
        'recipient_email',
        'subject',
        'body_text',
        'status',
        'attempts',
        'sent_at',
        'next_attempt_at',
        'last_error',
        'created_at',
        'updated_at',
      ].sort(),
    );
  });

  it('cascades step approval release item and outbox deletes when a deployment is removed', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d4','p1','dev','abc')",
    ).run();
    db.prepare(
      "INSERT INTO deployment_steps (id, deployment_id, name, step_order) VALUES ('s1','d4','build',0)",
    ).run();
    db.prepare(
      "INSERT INTO deployment_approvals (id, deployment_id, approver_user_id, approver_role) VALUES ('a1','d4','u1','Admin')",
    ).run();
    db.prepare(
      "INSERT INTO deployment_release_items (id, deployment_id, card_id) VALUES ('ri1','d4','card-1')",
    ).run();
    db.prepare(
      `INSERT INTO release_notification_outbox
         (id, project_id, deployment_id, release_item_id, notification_type, idempotency_key,
          recipient_email, subject, body_text)
       VALUES ('n1','p1','d4','ri1','ticket_release','key-1','a@example.com','Subject','Body')`,
    ).run();

    db.prepare("DELETE FROM deployments WHERE id = 'd4'").run();

    expect(db.prepare('SELECT COUNT(*) c FROM deployment_steps').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_approvals').get()).toMatchObject({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM deployment_release_items').get()).toMatchObject({
      c: 0,
    });
    expect(db.prepare('SELECT COUNT(*) c FROM release_notification_outbox').get()).toMatchObject({
      c: 0,
    });
  });

  it('defines idempotent release items per deployment/card', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d-release','p1','production','abc')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_release_items (id, deployment_id) VALUES ('bad','d-release')",
        )
        .run(),
    ).toThrow(/NOT NULL/i);

    db.prepare(
      "INSERT INTO deployment_release_items (id, deployment_id, card_id, support_ticket_id) VALUES ('r1','d-release','c1','t1')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_release_items (id, deployment_id, card_id, support_ticket_id) VALUES ('r2','d-release','c1','t1')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
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

  it('constrains deployment release item source and inclusion status', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d6','p1','dev','abc')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_release_items (id, deployment_id, card_id, source) VALUES ('ri-bad-source','d6','c1','scan')",
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_release_items (id, deployment_id, card_id, inclusion_status) VALUES ('ri-bad-status','d6','c1','pending')",
        )
        .run(),
    ).toThrow(/CHECK/i);
  });

  it('enforces one release item per deployment card', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d7','p1','dev','abc')",
    ).run();
    db.prepare(
      "INSERT INTO deployment_release_items (id, deployment_id, card_id) VALUES ('ri1','d7','card-1')",
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO deployment_release_items (id, deployment_id, card_id) VALUES ('ri2','d7','card-1')",
        )
        .run(),
    ).toThrow(/UNIQUE/i);
  });

  it('enforces outbox type status and idempotency key constraints', () => {
    db.prepare(
      "INSERT INTO deployments (id, project_id, environment, ref) VALUES ('d8','p1','prod','abc')",
    ).run();
    db.prepare(
      `INSERT INTO release_notification_outbox
         (id, project_id, deployment_id, notification_type, idempotency_key,
          recipient_email, subject, body_text)
       VALUES ('n2','p1','d8','release_digest','key-2','ops@example.com','Subject','Body')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO release_notification_outbox
             (id, project_id, deployment_id, notification_type, idempotency_key,
              recipient_email, subject, body_text)
           VALUES ('n3','p1','d8','digest','key-3','ops@example.com','Subject','Body')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO release_notification_outbox
             (id, project_id, deployment_id, notification_type, idempotency_key,
              recipient_email, subject, body_text, status)
           VALUES ('n4','p1','d8','release_digest','key-4','ops@example.com','Subject','Body','done')`,
        )
        .run(),
    ).toThrow(/CHECK/i);
    expect(() =>
      db
        .prepare(
          `INSERT INTO release_notification_outbox
             (id, project_id, deployment_id, notification_type, idempotency_key,
              recipient_email, subject, body_text)
           VALUES ('n5','p1','d8','release_digest','key-2','ops@example.com','Subject','Body')`,
        )
        .run(),
    ).toThrow(/UNIQUE/i);
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
    expect(namedIdx(db, 'deployment_release_items')).toEqual(
      [
        'idx_deployment_release_items_card',
        'idx_deployment_release_items_deployment',
        'idx_deployment_release_items_ticket',
      ].sort(),
    );
    expect(namedIdx(db, 'release_notification_outbox')).toEqual(
      [
        'idx_release_notification_outbox_deployment',
        'idx_release_notification_outbox_project_status',
        'idx_release_notification_outbox_ticket',
      ].sort(),
    );
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
