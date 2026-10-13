import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { beforeAll, describe, expect, it } from 'vitest';
import { getDb, initDb } from './db.js';
import { rebuildTableWithDdl } from './sqlite-widen-check.js';
import { normalizeKanbanTitle } from './kanban-title.js';

// An install whose kanban_cards.source_type CHECK predates `hub_chat` (the
// column already exists, so the ALTER that declares it never runs again) must
// accept `hub_chat` after boot and keep its existing cards and children.
type Row = Record<string, unknown>;
let cards: Row[] = [];
let comments: Row[] = [];

beforeAll(() => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'ah-hub-chat-source-src-'));
  const legacyDir = mkdtempSync(path.join(tmpdir(), 'ah-hub-chat-source-legacy-'));
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
  expect(current).toContain(",'hub_chat'");
  rebuildTableWithDdl(legacy, 'kanban_cards', current.replace(",'hub_chat'", ''));
  legacy.exec(`
    INSERT INTO kanban_boards (id, project_id, name) VALUES ('b1', 'p1', 'Board');
    INSERT INTO kanban_columns (id, board_id, name) VALUES ('c1', 'b1', 'To Do');
    INSERT INTO kanban_cards (id, column_id, board_id, title, source_type, source_id, source_meta)
    VALUES
      ('chat-card', 'c1', 'b1', 'From chat', 'chat', 'spaces/A/messages/M', '{"kind":"google-chat"}'),
      ('plain-card', 'c1', 'b1', 'Hand made', NULL, NULL, NULL);
    INSERT INTO kanban_card_comments (id, card_id, author, content)
    VALUES ('k1', 'chat-card', 'dana', 'keep me');
  `);
  expect(() =>
    legacy
      .prepare(
        "INSERT INTO kanban_cards (id, column_id, board_id, title, source_type) VALUES ('x', 'c1', 'b1', 'x', 'hub_chat')",
      )
      .run(),
  ).toThrow(/CHECK/);
  legacy.close();

  initDb(legacyDir);
  const db = getDb();
  cards = db.prepare('SELECT id, source_type FROM kanban_cards ORDER BY id').all() as Row[];
  comments = db.prepare('SELECT id, card_id FROM kanban_card_comments').all() as Row[];
});

describe('kanban_cards hub_chat source migration', () => {
  it('widens the CHECK on an upgraded install to accept hub_chat', () => {
    expect(() =>
      getDb()
        .prepare(
          "INSERT INTO kanban_cards (id, column_id, board_id, title, source_type, source_id) VALUES ('new-hub', 'c1', 'b1', 't', 'hub_chat', 'm1')",
        )
        .run(),
    ).not.toThrow();
  });

  it('keeps existing cards and their comments', () => {
    expect(cards).toEqual([
      { id: 'chat-card', source_type: 'chat' },
      { id: 'plain-card', source_type: null },
    ]);
    expect(comments).toEqual([{ id: 'k1', card_id: 'chat-card' }]);
    expect(getDb().pragma('foreign_key_check')).toEqual([]);
  });
});
