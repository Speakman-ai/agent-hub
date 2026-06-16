/**
 * Regression test for API docs generation failing against legacy databases.
 *
 * The OpenAPI generator imports every route module. Many routes import db.ts,
 * which runs initDb(config.dataDir) at module load. A legacy support_tickets
 * table without read_at used to fail during bootstrap because the
 * idx_support_tickets_unread index referenced read_at before the later
 * migration added the column.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

describe('support_tickets read_at migration ordering', () => {
  it('initDb survives a legacy support_tickets table missing read_at', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(`
      CREATE TABLE support_tickets (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'other'
          CHECK(type IN ('bug','question','feature_request','incident','other')),
        severity TEXT NOT NULL DEFAULT 'medium'
          CHECK(severity IN ('critical','high','medium','low')),
        status TEXT NOT NULL DEFAULT 'new'
          CHECK(status IN ('new','investigating','converted','closed')),
        subject TEXT NOT NULL DEFAULT '',
        body TEXT NOT NULL DEFAULT '',
        reporter TEXT,
        ai_summary TEXT,
        ai_investigation TEXT,
        ai_investigated_at TEXT,
        replay_ref TEXT,
        screenshot_ref TEXT,
        converted_card_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO support_tickets (id, project_id, body)
      VALUES ('ticket-legacy', 'agent-hub', 'legacy ticket');
    `);
    seed.close();

    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });
    const cols = (verify.pragma('table_info(support_tickets)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('read_at');

    const row = verify
      .prepare('SELECT id, read_at FROM support_tickets WHERE id = ?')
      .get('ticket-legacy') as { id: string; read_at: string | null } | undefined;
    expect(row).toEqual({ id: 'ticket-legacy', read_at: null });

    const indexes = (verify.pragma('index_list(support_tickets)') as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).toContain('idx_support_tickets_unread');
    verify.close();
  });
});
