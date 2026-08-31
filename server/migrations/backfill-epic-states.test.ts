import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { backfillEpicStates, EPIC_STATES_BACKFILL_MARKER } from './backfill-epic-states.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kanban_epics (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      state TEXT DEFAULT NULL
    );
    CREATE TABLE kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      column_id TEXT NOT NULL,
      epic_id TEXT
    );
  `);
  // One board: To Do + Done columns.
  db.prepare('INSERT INTO kanban_columns (id, board_id, name) VALUES (?, ?, ?)').run(
    'todo',
    'b1',
    'To Do',
  );
  db.prepare('INSERT INTO kanban_columns (id, board_id, name) VALUES (?, ?, ?)').run(
    'done',
    'b1',
    'Done',
  );
  return db;
}

function insertEpic(db: Database.Database, id: string, state: string | null) {
  db.prepare('INSERT INTO kanban_epics (id, board_id, state) VALUES (?, ?, ?)').run(
    id,
    'b1',
    state,
  );
}

function insertCard(db: Database.Database, id: string, columnId: string, epicId: string | null) {
  db.prepare('INSERT INTO kanban_cards (id, board_id, column_id, epic_id) VALUES (?, ?, ?, ?)').run(
    id,
    'b1',
    columnId,
    epicId,
  );
}

function epicState(db: Database.Database, id: string): string | null {
  return (
    db.prepare('SELECT state FROM kanban_epics WHERE id = ?').get(id) as { state: string | null }
  ).state;
}

describe('backfillEpicStates', () => {
  let dataDir: string;
  let db: Database.Database;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'epic-states-backfill-'));
    db = makeDb();
  });

  afterEach(() => {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('corrects a stale persisted state left by a pre-migration column rename', () => {
    // Pre-migration reality: all of e1's cards sit in Done, but its stored state
    // is stale 'in_progress' (e.g. the column was renamed to "Done" while reads
    // were still live-derived, so the stored value was never refreshed).
    insertEpic(db, 'e1', 'in_progress');
    insertCard(db, 'c1', 'done', 'e1');
    insertCard(db, 'c2', 'done', 'e1');

    const r = backfillEpicStates({ db, dataDir });

    expect(r.ran).toBe(true);
    expect(r.updated).toBe(1);
    expect(epicState(db, 'e1')).toBe('done');
    expect(existsSync(r.markerPath)).toBe(true);
    expect(r.markerPath).toBe(path.join(dataDir, EPIC_STATES_BACKFILL_MARKER));
  });

  it('backfills a NULL state and leaves already-correct states untouched', () => {
    insertEpic(db, 'e_null', null); // never computed
    insertCard(db, 'a', 'todo', 'e_null'); // -> not_started
    insertEpic(db, 'e_ok', 'not_started'); // already correct
    insertCard(db, 'b', 'todo', 'e_ok');

    const r = backfillEpicStates({ db, dataDir });

    expect(epicState(db, 'e_null')).toBe('not_started');
    expect(epicState(db, 'e_ok')).toBe('not_started');
    expect(r.updated).toBe(1); // only the NULL one changed
  });

  it('persists a card-less epic as not_started (never NULL)', () => {
    // A card-less epic computes to no state (computeEpicState -> null). It must
    // NOT be persisted as NULL: the column may be a legacy NOT NULL definition
    // where that throws. Coalesced to 'not_started'.
    insertEpic(db, 'empty', 'done'); // stale non-null on an empty epic
    const r = backfillEpicStates({ db, dataDir });
    expect(epicState(db, 'empty')).toBe('not_started');
    expect(r.updated).toBe(1);
  });

  it('does not crash on a legacy NOT NULL state column (prod schema drift)', () => {
    // Reproduces the prod boot crash: `kanban_epics.state` is a legacy
    // `TEXT NOT NULL DEFAULT 'open'` column, and one epic has no cards. The old
    // code wrote NULL -> SQLITE_CONSTRAINT_NOTNULL -> initDb threw -> restart loop.
    const legacy = new Database(':memory:');
    legacy.exec(`
      CREATE TABLE kanban_epics (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open'
      );
      CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, column_id TEXT NOT NULL, epic_id TEXT);
    `);
    legacy.prepare('INSERT INTO kanban_columns (id, board_id, name) VALUES (?, ?, ?)').run('todo', 'b1', 'To Do'); // prettier-ignore
    legacy.prepare('INSERT INTO kanban_columns (id, board_id, name) VALUES (?, ?, ?)').run('done', 'b1', 'Done'); // prettier-ignore
    legacy
      .prepare("INSERT INTO kanban_epics (id, board_id, state) VALUES ('empty', 'b1', 'open')")
      .run();
    legacy
      .prepare("INSERT INTO kanban_epics (id, board_id, state) VALUES ('withcards', 'b1', 'open')")
      .run();
    legacy.prepare("INSERT INTO kanban_cards (id, board_id, column_id, epic_id) VALUES ('c1', 'b1', 'done', 'withcards')").run(); // prettier-ignore

    try {
      const r = backfillEpicStates({ db: legacy, dataDir });
      expect(r.ran).toBe(true);
      // card-less epic coalesced to a safe non-null value; the other normalized.
      expect(
        (legacy.prepare('SELECT state FROM kanban_epics WHERE id = ?').get('empty') as { state: string }).state, // prettier-ignore
      ).toBe('not_started');
      expect(
        (legacy.prepare('SELECT state FROM kanban_epics WHERE id = ?').get('withcards') as { state: string }).state, // prettier-ignore
      ).toBe('done');
    } finally {
      legacy.close();
    }
  });

  it('throws when the recompute fails, so startup aborts rather than serve stale state', () => {
    // A DB missing kanban_cards makes the recompute query fail. The failure must
    // propagate (not be swallowed) and the marker must NOT be written, so the
    // next boot retries.
    const broken = new Database(':memory:');
    broken.exec(`
      CREATE TABLE kanban_epics (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, state TEXT);
      CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL);
    `);
    broken
      .prepare('INSERT INTO kanban_epics (id, board_id, state) VALUES (?, ?, ?)')
      .run('e1', 'b1', 'in_progress');
    try {
      expect(() => backfillEpicStates({ db: broken, dataDir })).toThrow();
      expect(existsSync(path.join(dataDir, EPIC_STATES_BACKFILL_MARKER))).toBe(false);
    } finally {
      broken.close();
    }
  });

  it('applies the recompute even when the marker write fails (best-effort marker)', () => {
    insertEpic(db, 'e1', 'in_progress');
    insertCard(db, 'c1', 'done', 'e1');
    // Point dataDir at a FILE, not a directory: the marker doesn't exist (no early
    // return) but the mkdirSync/writeFileSync marker persistence fails. The
    // recompute must still stand, and the failure must not throw.
    const fileDataDir = path.join(dataDir, 'not-a-dir');
    writeFileSync(fileDataDir, 'x');

    const r = backfillEpicStates({ db, dataDir: fileDataDir });

    expect(r.ran).toBe(true);
    expect(r.markerWritten).toBe(false);
    expect(epicState(db, 'e1')).toBe('done'); // recompute still applied
  });

  it('is a no-op once the marker exists', () => {
    insertEpic(db, 'e1', 'in_progress');
    insertCard(db, 'c1', 'done', 'e1');
    const first = backfillEpicStates({ db, dataDir });
    expect(first.ran).toBe(true);
    expect(epicState(db, 'e1')).toBe('done');

    // Simulate later drift; a second call must NOT re-run (marker present).
    db.prepare("UPDATE kanban_epics SET state = 'in_progress' WHERE id = ?").run('e1');
    const second = backfillEpicStates({ db, dataDir });
    expect(second.ran).toBe(false);
    expect(second.updated).toBe(0);
    expect(epicState(db, 'e1')).toBe('in_progress'); // untouched — marker gated
  });
});
