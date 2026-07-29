/**
 * Legacy webhook table removal — schema-convergence migration test.
 *
 * The GitHub App / inbound-webhook feature is long gone. `webhook_logs` and
 * `webhook_events` are now dropped in the pre-bootstrap block of `initDb`,
 * and `webhook_configs` is dropped by `migrateWebhookRepoToProject` after it
 * consumes the `repo_url` rows one last time.
 *
 * The invariant that matters on an upgrade like this is convergence: a brand
 * new install and a webhook-era install must end up with byte-identical
 * schemas. A regression where the DDL is deleted but the DROP is forgotten
 * (or vice versa) shows up here as a schema diff, which is exactly the class
 * of bug that used to surface as a boot-time `no such column: pr_key`.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import Database from 'better-sqlite3';
import { initDb, getDb } from './db.js';
import { migrateWebhookRepoToProject } from './project-model.js';

/** Normalized `sqlite_master` snapshot: every table/index/trigger DDL. */
function schemaSnapshot(db: InstanceType<typeof Database>): string[] {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((r) => `${r.type}:${r.name}:${(r.sql ?? '').replace(/\s+/g, ' ').trim()}`);
}

/**
 * Recreate the webhook-era schema exactly as it shipped before this change:
 * `webhook_events` without the P1 columns (pr_key / deferred_until /
 * superseded_by) and with the pre-'skipped' CHECK set, plus `webhook_configs`
 * without `author_allowlist`. Those are the shapes the deleted pre-bootstrap
 * ALTERs and post-bootstrap CHECK rebuild existed to repair, so seeding them
 * proves the drops make the repairs unnecessary rather than merely untested.
 */
function seedLegacyWebhookSchema(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.exec(`
    CREATE TABLE webhook_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      repo_url TEXT NOT NULL,
      secret TEXT NOT NULL,
      events TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_webhook_configs_project ON webhook_configs(project_id);

    CREATE TABLE webhook_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      action TEXT,
      delivery_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_webhook_logs_config ON webhook_logs(webhook_config_id);
    CREATE INDEX idx_webhook_logs_created ON webhook_logs(created_at DESC);

    CREATE TABLE webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_config_id INTEGER NOT NULL,
      delivery_id TEXT,
      event_type TEXT NOT NULL,
      action TEXT,
      payload TEXT NOT NULL,
      signature TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','processing','done','error')),
      started_at TEXT,
      completed_at TEXT,
      error_message TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_webhook_events_status ON webhook_events(status, created_at);

    INSERT INTO webhook_configs (project_id, repo_url, secret, events)
      VALUES ('no-such-project', 'https://github.com/acme/widgets', 's', '{}');
    INSERT INTO webhook_logs (webhook_config_id, event_type) VALUES (1, 'pull_request');
    INSERT INTO webhook_events (webhook_config_id, event_type, payload)
      VALUES (1, 'pull_request', '{}');
  `);
  seed.close();
}

let freshSchema: string[];
let upgradedSchema: string[];
let upgradedDb: InstanceType<typeof Database>;

beforeAll(() => {
  const freshDir = mkdtempSync(path.join(tmpdir(), 'ah-webhook-drop-fresh-'));
  initDb(freshDir);
  freshSchema = schemaSnapshot(getDb());

  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-webhook-drop-legacy-'));
  seedLegacyWebhookSchema(path.join(legacyDir, 'agent-hub.db'));
  initDb(legacyDir);
  // The webhook_configs row points at a project id that doesn't exist, so the
  // migration finds nothing to copy and writes no projects.json — it still
  // performs the DROP, which is the half under test here.
  migrateWebhookRepoToProject();
  upgradedDb = getDb();
  upgradedSchema = schemaSnapshot(upgradedDb);
});

describe('legacy webhook table removal', () => {
  it('a fresh DB and a webhook-era DB converge on the same schema', () => {
    expect(upgradedSchema).toEqual(freshSchema);
  });

  it('drops webhook_configs, webhook_logs and webhook_events on upgrade', () => {
    const tables = upgradedSchema.filter((s) => s.startsWith('table:')).map((s) => s.split(':')[1]);
    expect(tables).not.toContain('webhook_configs');
    expect(tables).not.toContain('webhook_logs');
    expect(tables).not.toContain('webhook_events');
  });

  it('leaves no orphaned webhook indexes behind', () => {
    // Name-anchored so the `workflows.webhook_path_token` column (a live,
    // unrelated feature) doesn't match.
    const webhookIndexes = (rows: string[]): string[] =>
      rows.filter((s) => s.startsWith('index:idx_webhook_'));
    expect(webhookIndexes(upgradedSchema)).toEqual([]);
    expect(webhookIndexes(freshSchema)).toEqual([]);
  });

  it('is idempotent — a second migration pass is a no-op', () => {
    migrateWebhookRepoToProject();
    expect(schemaSnapshot(upgradedDb)).toEqual(freshSchema);
  });
});
