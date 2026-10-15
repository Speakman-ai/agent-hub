/**
 * `migrateHubChatDigestsToIdKeyed` moves one-row-per-channel digests into
 * id-keyed `hub_chat_digests` rows and drops the old table. It must survive a
 * re-run, an empty table, and an old table that predates later columns.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const { initDb, getDb } = await import('./db.js');
const { HUB_CHAT_SCHEMA, migrateHubChatDigestsToIdKeyed } = await import('./hub-chat-schema.js');

const DAY_MS = 24 * 60 * 60_000;

/** The one-per-channel table as it last shipped. */
const OLD_DIGESTS = `
  CREATE TABLE hub_chat_channel_digests (
    channel_id      TEXT PRIMARY KEY,
    enabled         INTEGER NOT NULL DEFAULT 1,
    cron            TEXT NOT NULL,
    time_zone       TEXT NOT NULL DEFAULT 'UTC',
    scope           TEXT NOT NULL,
    project_id      TEXT,
    owner_user_id   TEXT NOT NULL,
    window_start    TEXT NOT NULL,
    last_run_at     TEXT,
    last_status     TEXT,
    last_error      TEXT,
    last_message_id TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;

/** The first shipped shape: no cursor or last_* status columns. */
const OLDEST_DIGESTS = `
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

function freshConn(oldTable: string): Database.Database {
  const conn = new Database(':memory:');
  conn.exec(HUB_CHAT_SCHEMA);
  conn.exec(oldTable);
  for (const id of ['c1', 'c2', 'c3']) {
    conn
      .prepare(
        `INSERT INTO hub_chat_channels (id, org_id, kind, name) VALUES (?, 'acme', 'channel', ?)`,
      )
      .run(id, id);
  }
  return conn;
}

function hasOldTable(conn: Database.Database): boolean {
  return !!conn
    .prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'hub_chat_channel_digests'`,
    )
    .get();
}

interface NewRow {
  id: string;
  channel_id: string;
  name: string;
  scope: string;
  project_ids: string;
  prompt: string | null;
  owner_user_id: string;
  window_start: string;
  last_run_at: string | null;
  last_status: string | null;
  last_message_id: string | null;
}

function newRows(conn: Database.Database): NewRow[] {
  return conn.prepare(`SELECT * FROM hub_chat_digests ORDER BY channel_id`).all() as NewRow[];
}

describe('migrateHubChatDigestsToIdKeyed', () => {
  it('copies each row with a fresh id, wraps project_id in project_ids, and drops the old table', () => {
    const conn = freshConn(OLD_DIGESTS);
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests
           (channel_id, cron, scope, project_id, owner_user_id, window_start, last_run_at,
            last_status, last_message_id)
         VALUES (?, '0 9 * * *', ?, ?, 'u1', ?, ?, ?, ?)`,
      )
      .run(
        'c1',
        'project',
        'web',
        '2026-10-14T09:00:00.000Z',
        '2026-10-14T09:00:00.000Z',
        'posted',
        'm1',
      );
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id, window_start)
         VALUES ('c2', '0 17 * * *', 'channel', 'u2', '2026-10-13T00:00:00.000Z')`,
      )
      .run();
    // A digest whose channel is gone is not carried over.
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id, window_start)
         VALUES ('gone', '0 9 * * *', 'channel', 'u1', '2026-10-13T00:00:00.000Z')`,
      )
      .run();

    migrateHubChatDigestsToIdKeyed(conn);

    expect(hasOldTable(conn)).toBe(false);
    const rows = newRows(conn);
    expect(rows).toHaveLength(2);
    const [project, channel] = rows;
    expect(project).toMatchObject({
      channel_id: 'c1',
      name: 'Project digest',
      scope: 'project',
      project_ids: '["web"]',
      prompt: null,
      owner_user_id: 'u1',
      window_start: '2026-10-14T09:00:00.000Z',
      last_status: 'posted',
      last_message_id: 'm1',
    });
    expect(channel).toMatchObject({
      channel_id: 'c2',
      name: 'Channel digest',
      project_ids: '[]',
      window_start: '2026-10-13T00:00:00.000Z',
    });
    expect(project!.id).not.toBe(channel!.id);
    expect(project!.id.length).toBeGreaterThan(0);
    conn.close();
  });

  it('is idempotent: a re-run neither duplicates rows nor throws', () => {
    const conn = freshConn(OLD_DIGESTS);
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id, window_start)
         VALUES ('c1', '0 9 * * *', 'channel', 'u1', '2026-10-13T00:00:00.000Z')`,
      )
      .run();
    migrateHubChatDigestsToIdKeyed(conn);
    const first = newRows(conn);
    migrateHubChatDigestsToIdKeyed(conn);
    expect(newRows(conn)).toEqual(first);
    conn.close();
  });

  it('drops an empty old table and leaves the new one empty', () => {
    const conn = freshConn(OLD_DIGESTS);
    migrateHubChatDigestsToIdKeyed(conn);
    expect(hasOldTable(conn)).toBe(false);
    expect(newRows(conn)).toEqual([]);
    conn.close();
  });

  it('does nothing when the old table never existed', () => {
    const conn = new Database(':memory:');
    conn.exec(HUB_CHAT_SCHEMA);
    expect(() => migrateHubChatDigestsToIdKeyed(conn)).not.toThrow();
    expect(newRows(conn)).toEqual([]);
    conn.close();
  });

  it('fills a cursor for a table that predates window_start: last run, else a day back', () => {
    const conn = freshConn(OLDEST_DIGESTS);
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id, last_run_at)
         VALUES ('c1', '0 9 * * *', 'channel', 'u1', '2026-10-10T09:00:00.000Z')`,
      )
      .run();
    conn
      .prepare(
        `INSERT INTO hub_chat_channel_digests (channel_id, cron, scope, owner_user_id)
         VALUES ('c2', '0 9 * * *', 'channel', 'u1')`,
      )
      .run();
    const before = Date.now();
    migrateHubChatDigestsToIdKeyed(conn);
    const [ran, fresh] = newRows(conn);
    expect(ran!.window_start).toBe('2026-10-10T09:00:00.000Z');
    expect(ran!.last_status).toBeNull();
    const freshMs = Date.parse(fresh!.window_start);
    expect(freshMs).toBeGreaterThanOrEqual(before - DAY_MS - 1000);
    expect(freshMs).toBeLessThanOrEqual(Date.now() - DAY_MS + 1000);
    conn.close();
  });

  it('runs at boot, so a database holding the old table still initializes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-digests-boot-'));
    const old = new Database(path.join(dir, 'agent-hub.db'));
    old.exec(OLDEST_DIGESTS);
    old.close();

    initDb(dir);
    expect(hasOldTable(getDb())).toBe(false);
    expect(newRows(getDb())).toEqual([]);
  });
});
