/**
 * The `simple_chat` column migration must not guess which older sessions the
 * Simple view opened. A consult created in the Hub can look exactly like one
 * (top-level, named "Chat"), and flagging it would drop it from the sidebar.
 *
 * Seeds the pre-migration `sessions` shape on disk before importing `db.ts`,
 * the same approach as `db-job-filter-drop-migration.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

describe('sessions.simple_chat migration', () => {
  it('adds the column without flagging an existing consult named Chat', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    const dbPath = path.join(dataDir, 'agent-hub.db');

    const seed = new Database(dbPath);
    seed.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        name TEXT NOT NULL,
        title_source TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        cron_id INTEGER,
        session_mode TEXT NOT NULL DEFAULT 'chat',
        sidebar_parent_id TEXT
      );
    `);
    seed
      .prepare('INSERT INTO sessions (id, agent_id, name, session_mode) VALUES (?, ?, ?, ?)')
      .run('hub-consult', 'agent-1', 'Chat', 'consult');
    seed.close();

    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });
    const row = verify
      .prepare('SELECT name, session_mode, simple_chat FROM sessions WHERE id = ?')
      .get('hub-consult');
    expect(row).toEqual({ name: 'Chat', session_mode: 'consult', simple_chat: 0 });
    verify.close();
  });
});
