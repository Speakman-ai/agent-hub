/**
 * Regression test for the 2026-05-07 deploy outage.
 *
 * PR #802 added `CREATE INDEX … ON webhook_events(pr_key, status)` inside the
 * bootstrap `db.exec` block in `server/db.ts`. For fresh installs this is
 * fine — the same block also creates `webhook_events` with a `pr_key`
 * column. But for legacy installs (dev + prod both ran into this), the
 * `CREATE TABLE IF NOT EXISTS webhook_events` is a no-op (the table was
 * created months earlier without `pr_key`), and the subsequent
 * `CREATE INDEX … (pr_key, …)` throws:
 *
 *     SqliteError: no such column: pr_key
 *         at initDb (server/db.ts:58)
 *
 * The column-add migration that should have fixed this lived AFTER the
 * failing block, so it never ran. Both EC2s crashed-looped after the deploy.
 *
 * The fix moves the `pr_key`/`deferred_until`/`superseded_by` `ALTER TABLE`
 * loop ABOVE the bootstrap `db.exec` so the column exists by the time the
 * index references it, regardless of how old the on-disk schema is.
 *
 * This test simulates the legacy-install case by hand-creating a pre-PR-802
 * `webhook_events` table in the per-file test data dir BEFORE importing
 * `db.ts`. If the migration ordering regresses, the dynamic import will
 * throw the same `no such column: pr_key` error and the test fails.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

describe('webhook_events pr_key migration ordering', () => {
  it('initDb survives a legacy webhook_events table missing pr_key/deferred_until/superseded_by', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    // Hand-craft a pre-PR-802 schema: webhook_events with the columns it had
    // before the P1 webhook coalescing work. Critically, no pr_key, no
    // deferred_until, no superseded_by, and the legacy CHECK constraint
    // without 'skipped' in the allowed status values.
    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = WAL');
    // webhook_configs schema matches the current production DDL — only
    // webhook_events is intentionally left in the pre-PR-802 shape.
    seed.exec(`
      CREATE TABLE webhook_configs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        repo_url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        author_allowlist TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
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
    `);
    seed
      .prepare(
        `INSERT INTO webhook_configs (id, project_id, repo_url, secret)
       VALUES (1, 'legacy-project', 'https://github.com/legacy/repo', 'legacy-secret')`,
      )
      .run();
    seed
      .prepare(
        `INSERT INTO webhook_events (webhook_config_id, event_type, payload)
       VALUES (1, 'pull_request', '{}')`,
      )
      .run();
    seed.close();

    // This is the regression: importing db.ts triggers initDb(config.dataDir)
    // at module load. Pre-fix, this throws SqliteError: no such column:
    // pr_key. Post-fix, the pre-bootstrap ALTER TABLE adds the columns
    // before the dependent CREATE INDEX runs.
    await expect(import('../db.js')).resolves.toBeDefined();

    // Confirm the migration ran end-to-end: the columns now exist and the
    // pre-existing legacy row survived.
    const verify = new Database(dbPath, { readonly: true });
    const cols = (verify.pragma('table_info(webhook_events)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('pr_key');
    expect(cols).toContain('deferred_until');
    expect(cols).toContain('superseded_by');

    const row = verify
      .prepare('SELECT id, event_type, pr_key FROM webhook_events WHERE id = 1')
      .get() as { id: number; event_type: string; pr_key: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row?.event_type).toBe('pull_request');
    expect(row?.pr_key).toBeNull();

    // CHECK-constraint rebuild should also have run (post-bootstrap block):
    // the table DDL must now allow status='skipped'.
    const ddl = (
      verify
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='webhook_events'")
        .get() as { sql: string } | undefined
    )?.sql;
    expect(ddl).toContain("'skipped'");

    // And the partial index that was the original failure point should now
    // exist.
    const indexes = (verify.pragma('index_list(webhook_events)') as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain('idx_webhook_events_pr_key_active');

    verify.close();
  });
});
