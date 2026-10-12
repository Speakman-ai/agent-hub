import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  repairCardSessionLinks,
  CARD_SESSION_LINK_REPAIR_MARKER,
} from './repair-card-session-links.js';

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, board_id TEXT, name TEXT);
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY, board_id TEXT, column_id TEXT, session_id TEXT,
      pr_url TEXT, position INTEGER DEFAULT 0, updated_at TEXT, epic_id TEXT
    );
    CREATE TABLE kanban_epics (id TEXT PRIMARY KEY, board_id TEXT, state TEXT);
    CREATE TABLE kanban_card_comments (id TEXT, card_id TEXT, author TEXT, content TEXT);
    CREATE TABLE pull_requests (project_id TEXT, number INTEGER, status TEXT);
    INSERT INTO kanban_columns VALUES ('todo', 'b', 'To Do'), ('prog', 'b', 'In Progress'), ('done', 'b', 'Done');
  `);
  return db;
}

function card(
  db: Database.Database,
  id: string,
  column: string,
  sessionId: string | null,
  prUrl: string | null = null,
) {
  db.prepare(
    'INSERT INTO kanban_cards (id, board_id, column_id, session_id, pr_url) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'b', column, sessionId, prUrl);
}

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT column_id, session_id FROM kanban_cards WHERE id = ?').get(id) as {
    column_id: string;
    session_id: string | null;
  };

describe('repairCardSessionLinks', () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'card-session-repair-'));
  });
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it('collapses doubled ids and prefers an existing session among conflicting ids', () => {
    const db = makeDb();
    db.exec("INSERT INTO sessions VALUES ('live'), ('s1')");
    card(db, 'c1', 'done', 's1, s1');
    card(db, 'c2', 'done', 'gone, live');

    const r = repairCardSessionLinks({ db, dataDir });
    expect(r.collapsed).toBe(2);
    expect(row(db, 'c1').session_id).toBe('s1');
    expect(row(db, 'c2').session_id).toBe('live');
  });

  it('moves In Progress cards on a missing session: merged PR to Done, otherwise To Do', () => {
    const db = makeDb();
    db.exec("INSERT INTO sessions VALUES ('live')");
    db.exec("INSERT INTO pull_requests VALUES ('st', 1558, 'merged'), ('st', 9, 'open')");
    card(db, 'merged', 'prog', 'gone-1', '/projects/st/pulls/1558');
    card(db, 'open-pr', 'prog', 'gone-2', '/projects/st/pulls/9');
    card(db, 'no-pr', 'prog', 'gone-3, gone-3');
    card(db, 'active', 'prog', 'live');
    card(db, 'unlinked', 'prog', null);
    card(db, 'todo', 'todo', 'gone-4');

    const r = repairCardSessionLinks({ db, dataDir });
    expect(r).toMatchObject({ movedToDone: 1, movedToTodo: 2 });
    expect(row(db, 'merged').column_id).toBe('done');
    expect(row(db, 'open-pr').column_id).toBe('todo');
    expect(row(db, 'no-pr')).toEqual({ column_id: 'todo', session_id: 'gone-3' });
    expect(row(db, 'active').column_id).toBe('prog');
    expect(row(db, 'unlinked').column_id).toBe('prog');
    expect(row(db, 'todo').column_id).toBe('todo');

    const comments = db
      .prepare('SELECT card_id, content FROM kanban_card_comments ORDER BY card_id')
      .all() as Array<{ card_id: string; content: string }>;
    expect(comments.map((c) => c.card_id)).toEqual(['merged', 'no-pr', 'open-pr']);
    expect(comments[0].content).toMatch(/is merged/);
    expect(comments[1].content).toMatch(/no longer exists/);
  });

  it('recomputes the epic of a moved card', () => {
    const db = makeDb();
    db.exec("INSERT INTO pull_requests VALUES ('st', 7, 'merged')");
    db.exec(
      "INSERT INTO kanban_epics VALUES ('e1', 'b', 'in_progress'), ('e2', 'b', 'in_progress')",
    );
    card(db, 'last-open', 'prog', 'gone', '/projects/st/pulls/7');
    card(db, 'shipped', 'done', null);
    card(db, 'untouched', 'prog', null);
    db.exec(
      "UPDATE kanban_cards SET epic_id = 'e1' WHERE id IN ('last-open', 'shipped'); UPDATE kanban_cards SET epic_id = 'e2' WHERE id = 'untouched'",
    );

    repairCardSessionLinks({ db, dataDir });

    const state = (id: string) =>
      (db.prepare('SELECT state FROM kanban_epics WHERE id = ?').get(id) as { state: string })
        .state;
    expect(row(db, 'last-open').column_id).toBe('done');
    expect(state('e1')).toBe('done');
    // An epic with no repaired card is left alone.
    expect(state('e2')).toBe('in_progress');
  });

  it('runs once', () => {
    const db = makeDb();
    card(db, 'c1', 'prog', 'gone');
    expect(repairCardSessionLinks({ db, dataDir }).ran).toBe(true);
    expect(existsSync(path.join(dataDir, CARD_SESSION_LINK_REPAIR_MARKER))).toBe(true);
    card(db, 'c2', 'prog', 'gone-too');
    expect(repairCardSessionLinks({ db, dataDir }).ran).toBe(false);
    expect(row(db, 'c2').column_id).toBe('prog');
  });
});
