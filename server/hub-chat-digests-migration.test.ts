/**
 * A `hub_chat_channel_digests` table created before `window_start` existed
 * must be healed at boot. The reconciler cannot add a NOT NULL column without
 * a default, so without the dedicated migration every digest save threw
 * `table hub_chat_channel_digests has no column named window_start`.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const { initDb, getDb } = await import('./db.js');
const { migrateHubChatDigestsWindowStart } = await import('./hub-chat-schema.js');
const { upsertChannelDigest, getChannelDigest } = await import('./hub-chat-digests-store.js');

const LEGACY_DIGESTS = `
  CREATE TABLE hub_chat_channel_digests (
    channel_id      TEXT PRIMARY KEY,
    enabled         INTEGER NOT NULL DEFAULT 1,
    cron            TEXT NOT NULL,
    time_zone       TEXT NOT NULL DEFAULT 'UTC',
    scope           TEXT NOT NULL,
    project_id      TEXT,
    owner_user_id   TEXT NOT NULL,
    last_run_at     TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;

function columns(conn: Database.Database): string[] {
  return (
    conn.prepare(`PRAGMA table_info('hub_chat_channel_digests')`).all() as { name: string }[]
  ).map((c) => c.name);
}

describe('migrateHubChatDigestsWindowStart', () => {
  it('lets a digest be saved on a database whose table predates window_start', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-digests-legacy-'));
    const legacy = new Database(path.join(dir, 'agent-hub.db'));
    legacy.exec(LEGACY_DIGESTS);
    legacy.close();

    initDb(dir);
    expect(columns(getDb())).toContain('window_start');

    getDb()
      .prepare(`INSERT INTO hub_chat_channels (id, org_id, kind, name) VALUES (?, ?, ?, ?)`)
      .run('c1', 'acme', 'channel', 'general');
    const now = new Date('2026-10-14T08:00:00.000Z');
    const saved = upsertChannelDigest({
      channelId: 'c1',
      enabled: true,
      cron: '0 9 * * *',
      timeZone: 'UTC',
      scope: 'channel',
      projectId: null,
      ownerUserId: 'u1',
      now,
    });
    expect(saved.window_start).toBe('2026-10-13T08:00:00.000Z');
    expect(getChannelDigest('c1')?.cron).toBe('0 9 * * *');
  });

  it('backfills existing rows from last_run_at, else a day back, and is idempotent', () => {
    const conn = new Database(':memory:');
    conn.exec(LEGACY_DIGESTS);
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id, last_run_at)
         VALUES (?, '0 9 * * *', 'channel', 'u1', ?)`,
      )
      .run('ran', '2026-10-10T09:00:00.000Z');
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id)
         VALUES ('fresh', '0 9 * * *', 'channel', 'u1')`,
      )
      .run();

    const before = Date.now();
    migrateHubChatDigestsWindowStart(conn);
    migrateHubChatDigestsWindowStart(conn);

    const rows = conn
      .prepare(`SELECT channel_id, window_start FROM hub_chat_channel_digests`)
      .all() as { channel_id: string; window_start: string }[];
    const byId = Object.fromEntries(rows.map((r) => [r.channel_id, r.window_start]));
    expect(byId.ran).toBe('2026-10-10T09:00:00.000Z');
    const freshMs = Date.parse(byId.fresh);
    expect(freshMs).toBeGreaterThanOrEqual(before - 24 * 60 * 60_000 - 1000);
    expect(freshMs).toBeLessThanOrEqual(Date.now() - 24 * 60 * 60_000 + 1000);
    conn.close();
  });

  it('does nothing when the table does not exist', () => {
    const conn = new Database(':memory:');
    expect(() => migrateHubChatDigestsWindowStart(conn)).not.toThrow();
    conn.close();
  });
});
