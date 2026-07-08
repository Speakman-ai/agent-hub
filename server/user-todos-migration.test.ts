import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
vi.mock('./config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb } = await import('./orgs.js');
const { createUser } = await import('./users-store.js');
const { getTodo } = await import('./user-todos-store.js');

/** The user_todos DDL as it shipped in P1, before the P4 additive columns. */
const LEGACY_USER_TODOS_SCHEMA = `
  CREATE TABLE user_todos (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title             TEXT NOT NULL,
    notes             TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done')),
    due_at            TEXT,
    position          INTEGER NOT NULL DEFAULT 0,
    source_type       TEXT NOT NULL DEFAULT 'manual' CHECK(source_type IN ('manual','email','calendar')),
    source_id         TEXT,
    source_meta       TEXT,
    linked_card_id    TEXT,
    linked_project_id TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function freshDb() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'user-todos-migration-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
}

function columnNames(): Set<string> {
  const cols = getOrgsDb().pragma('table_info(user_todos)') as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

describe('user_todos additive migration', () => {
  beforeEach(() => {
    freshDb();
  });

  it('adds the P4 columns and backfills the polymorphic link from linked_card_id', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });

    // Roll the table back to the pre-P4 (P1) shape and seed a legacy row that
    // was promoted to a card before the polymorphic link existed.
    const db = getOrgsDb();
    db.exec('DROP TABLE user_todos');
    db.exec(LEGACY_USER_TODOS_SCHEMA);
    db.prepare(
      `INSERT INTO user_todos
         (id, user_id, title, notes, status, position, source_type, linked_card_id, linked_project_id)
       VALUES (?, ?, ?, '', 'open', 0, 'manual', ?, ?)`,
    ).run('todo-legacy', user.id, 'legacy promoted todo', 'card-42', 'proj-9');
    // An un-promoted legacy row: no card link, must stay unlinked after migrate.
    db.prepare(
      `INSERT INTO user_todos
         (id, user_id, title, notes, status, position, source_type)
       VALUES (?, ?, ?, '', 'open', 1, 'manual')`,
    ).run('todo-plain', user.id, 'plain legacy todo');

    // Re-run init → applies the additive migration against the legacy table.
    initOrgsDb();

    const cols = columnNames();
    for (const c of [
      'priority',
      'do_date',
      'do_start_at',
      'do_end_at',
      'linked_type',
      'linked_id',
    ]) {
      expect(cols.has(c)).toBe(true);
    }

    const promoted = getTodo(user.id, 'todo-legacy')!;
    expect(promoted.priority).toBe('medium'); // column default backfilled onto existing rows
    expect(promoted.doDate).toBeNull();
    expect(promoted.linkedType).toBe('card'); // backfilled from linked_card_id
    expect(promoted.linkedId).toBe('card-42');
    expect(promoted.linkedCardId).toBe('card-42'); // preserved
    expect(promoted.linkedProjectId).toBe('proj-9');

    const plain = getTodo(user.id, 'todo-plain')!;
    expect(plain.linkedType).toBeNull(); // no card link → stays unlinked
    expect(plain.linkedId).toBeNull();
    expect(plain.priority).toBe('medium');
  });

  it('is idempotent — re-running init leaves the backfilled link untouched', () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const db = getOrgsDb();
    db.exec('DROP TABLE user_todos');
    db.exec(LEGACY_USER_TODOS_SCHEMA);
    db.prepare(
      `INSERT INTO user_todos
         (id, user_id, title, notes, status, position, source_type, linked_card_id, linked_project_id)
       VALUES (?, ?, ?, '', 'open', 0, 'manual', ?, ?)`,
    ).run('todo-legacy', user.id, 'legacy', 'card-42', 'proj-9');

    // Three consecutive inits must not throw and must not mutate the backfill.
    initOrgsDb();
    initOrgsDb();
    initOrgsDb();

    const todo = getTodo(user.id, 'todo-legacy')!;
    expect(todo.linkedType).toBe('card');
    expect(todo.linkedId).toBe('card-42');
    expect(todo.linkedCardId).toBe('card-42');
  });
});
