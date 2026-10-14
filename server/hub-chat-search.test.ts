import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { HUB_CHAT_SCHEMA, applyHubChatSearchIndex } from './hub-chat-schema.js';
import { buildHubChatFtsQuery } from './hub-chat-search.js';

function insert(db: Database.Database, id: string, body: string) {
  db.prepare(
    `INSERT INTO hub_chat_messages (id, channel_id, seq, author_kind, body)
     VALUES (?, 'c1', ?, 'user', ?)`,
  ).run(id, Number(id.replace(/\D/g, '')), body);
}

function match(db: Database.Database, q: string): string[] {
  return (
    db
      .prepare(
        `SELECT m.id FROM hub_chat_messages_fts f JOIN hub_chat_messages m ON m.rowid = f.rowid
         WHERE hub_chat_messages_fts MATCH ? ORDER BY m.id`,
      )
      .all(q) as { id: string }[]
  ).map((r) => r.id);
}

describe('hub chat search index', () => {
  it('backfills existing messages on first creation and is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(HUB_CHAT_SCHEMA);
    db.prepare(
      "INSERT INTO hub_chat_channels (id, org_id, kind) VALUES ('c1', 'o', 'channel')",
    ).run();
    insert(db, 'm1', 'existing history');
    applyHubChatSearchIndex(db);
    expect(() => applyHubChatSearchIndex(db)).not.toThrow();
    expect(match(db, 'history')).toEqual(['m1']);
    insert(db, 'm2', 'new history');
    expect(match(db, 'history')).toEqual(['m1', 'm2']);
    db.pragma('foreign_keys = ON');
    db.prepare("DELETE FROM hub_chat_channels WHERE id = 'c1'").run();
    expect(match(db, 'history')).toEqual([]);
  });
});

describe('buildHubChatFtsQuery', () => {
  it('quotes each word as a prefix term', () => {
    expect(buildHubChatFtsQuery('Deploy  prod')).toBe('"Deploy"* "prod"*');
  });
  it('keeps every distinct word, however many there are', () => {
    const q = buildHubChatFtsQuery(`${'alpha '.repeat(12)}zebra`);
    expect(q).toBe('"alpha"* "zebra"*');
    const many = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
    expect(buildHubChatFtsQuery(many)?.split(' ')).toHaveLength(20);
  });
  it('drops FTS operators and punctuation', () => {
    expect(buildHubChatFtsQuery('a" OR (b*')).toBe('"a"* "OR"* "b"*');
    expect(buildHubChatFtsQuery(' "" () ')).toBeNull();
  });
});
