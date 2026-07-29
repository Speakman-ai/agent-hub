import { describe, expect, it } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { openScratchDb } from './destructive-db.js';

describe('heartbeat_state schema cleanup', () => {
  it('removes stale ownership columns and indexes while preserving run state', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = openScratchDb(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(`
      CREATE TABLE heartbeat_state (
        agent_id TEXT PRIMARY KEY,
        next_run_at TEXT,
        last_run_at TEXT,
        owner_user_id TEXT,
        shared INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_heartbeat_state_owner ON heartbeat_state(owner_user_id);
      CREATE INDEX idx_heartbeat_state_shared ON heartbeat_state(shared);
      INSERT INTO heartbeat_state (agent_id, next_run_at, last_run_at, owner_user_id, shared)
      VALUES ('agent-1', '2026-06-29T10:00:00.000Z', '2026-06-29T09:00:00.000Z', 'user-a', 1);
    `);
    seed.close();

    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });
    const cols = (verify.pragma('table_info(heartbeat_state)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(['agent_id', 'next_run_at', 'last_run_at']);

    const indexes = (verify.pragma('index_list(heartbeat_state)') as { name: string }[]).map(
      (i) => i.name,
    );
    expect(indexes).not.toContain('idx_heartbeat_state_owner');
    expect(indexes).not.toContain('idx_heartbeat_state_shared');

    const row = verify
      .prepare('SELECT * FROM heartbeat_state WHERE agent_id = ?')
      .get('agent-1') as Record<string, unknown>;
    expect(row).toEqual({
      agent_id: 'agent-1',
      next_run_at: '2026-06-29T10:00:00.000Z',
      last_run_at: '2026-06-29T09:00:00.000Z',
    });
    verify.close();
  });
});
