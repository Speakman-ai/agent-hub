import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from './db.js';
import { rebuildTableWithDdl } from './sqlite-widen-check.js';
import { normalizeKanbanTitle } from './kanban-title.js';

// An install whose kanban_cards.source_type CHECK predates `chat` must accept
// `chat` after boot, keep every card and its children, and relabel the Chat
// captures that were stamped `manual` before the type existed.
type Row = Record<string, unknown>;
let cards: Row[] = [];
let comments: Row[] = [];
let ddl = '';
let indexes: string[] = [];
let triggers: string[] = [];

beforeAll(() => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'ah-chat-source-src-'));
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-chat-source-legacy-'));
  const legacyPath = path.join(legacyDir, 'agent-hub.db');

  initDb(sourceDir);
  getDb().exec(`VACUUM INTO '${legacyPath.replaceAll("'", "''")}'`);

  const legacy = new Database(legacyPath);
  legacy.function('kanban_title_norm', { deterministic: true }, (v: unknown) =>
    normalizeKanbanTitle(v),
  );
  const current = (
    legacy.prepare("SELECT sql FROM sqlite_master WHERE name = 'kanban_cards'").get() as {
      sql: string;
    }
  ).sql;
  rebuildTableWithDdl(legacy, 'kanban_cards', current.replace(",'chat'", ''));
  legacy.exec(`
    INSERT INTO kanban_boards (id, project_id, name) VALUES ('b1', 'p1', 'Board');
    INSERT INTO kanban_columns (id, board_id, name) VALUES ('c1', 'b1', 'To Do');
    INSERT INTO kanban_cards (id, column_id, board_id, title, source_type, source_id, source_meta)
    VALUES
      ('chat-card', 'c1', 'b1', 'From chat', 'manual', 'spaces/A/messages/M',
       '{"kind":"google-chat","deepLink":"https://chat.google.com/room/A"}'),
      ('plain-card', 'c1', 'b1', 'Hand made', 'manual', NULL, NULL),
      ('bad-meta', 'c1', 'b1', 'Odd meta', 'manual', NULL, 'not json'),
      ('mail-card', 'c1', 'b1', 'From mail', 'email', 'm1', '{"kind":"gmail"}');
    INSERT INTO kanban_card_comments (id, card_id, author, content)
    VALUES ('k1', 'chat-card', 'dana', 'keep me');
  `);
  expect(() =>
    legacy
      .prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, source_type) VALUES ('x', 'c1', 'b1', 'x', 'chat')",
      )
      .run(),
  ).toThrow(/CHECK/);
  legacy.close();

  initDb(legacyDir);
  const db = getDb();
  cards = db
    .prepare('SELECT id, source_type, short_id FROM kanban_cards ORDER BY id')
    .all() as Row[];
  comments = db.prepare('SELECT id, card_id FROM kanban_card_comments').all() as Row[];
  ddl = (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'kanban_cards'").get() as {
      sql: string;
    }
  ).sql;
  const deps = db
    .prepare("SELECT type, name FROM sqlite_master WHERE tbl_name = 'kanban_cards'")
    .all() as { type: string; name: string }[];
  indexes = deps.filter((d) => d.type === 'index').map((d) => d.name);
  triggers = deps.filter((d) => d.type === 'trigger').map((d) => d.name);
});

describe('kanban_cards chat source migration', () => {
  it('widens the CHECK to accept chat', () => {
    expect(ddl).toContain("'chat'");
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO kanban_cards (id, column_id, board_id, title, source_type) VALUES ('new-chat', 'c1', 'b1', 't', 'chat')",
        )
        .run(),
    ).not.toThrow();
  });

  it('backfills only google-chat manual cards', () => {
    const byId = Object.fromEntries(cards.map((c) => [c.id, c.source_type]));
    expect(byId).toEqual({
      'bad-meta': 'manual',
      'chat-card': 'chat',
      'mail-card': 'email',
      'plain-card': 'manual',
    });
  });

  it('keeps children, indexes, and triggers', () => {
    expect(comments).toEqual([{ id: 'k1', card_id: 'chat-card' }]);
    expect(indexes).toEqual(
      expect.arrayContaining(['idx_kanban_cards_board', 'idx_kanban_cards_source']),
    );
    expect(triggers).toEqual(expect.arrayContaining(['trg_kanban_cards_labels_ai']));
    expect(cards.every((c) => typeof c.short_id === 'number')).toBe(true);
  });

  it('leaves foreign keys enforced', () => {
    expect(getDb().pragma('foreign_keys', { simple: true })).toBe(1);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });
});
