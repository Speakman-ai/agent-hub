import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { collapseReviewColumn } from './collapse-review-column.js';

/**
 * Minimal kanban schema mirroring the columns the migration touches
 * (`server/db.ts` defines the full tables). `ON DELETE CASCADE` on
 * `kanban_cards.column_id` is included on purpose — it's the exact hazard
 * the migration guards against by moving cards out before deleting Review.
 */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES kanban_columns(id) ON DELETE CASCADE
    );
  `);
  return db;
}

function addColumn(
  db: Database.Database,
  id: string,
  boardId: string,
  name: string,
  position: number,
): void {
  db.prepare('INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?,?,?,?)').run(
    id,
    boardId,
    name,
    position,
  );
}

function addCard(
  db: Database.Database,
  id: string,
  boardId: string,
  columnId: string,
  position: number,
  updatedAt = '2020-01-01 00:00:00',
): void {
  db.prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title, position, updated_at) VALUES (?,?,?,?,?,?)',
  ).run(id, columnId, boardId, `card-${id}`, position, updatedAt);
}

function colNames(db: Database.Database, boardId: string): string[] {
  return (
    db
      .prepare('SELECT name FROM kanban_columns WHERE board_id = ? ORDER BY position ASC')
      .all(boardId) as Array<{ name: string }>
  ).map((c) => c.name);
}

function cardColumn(db: Database.Database, cardId: string): string | undefined {
  return (
    db.prepare('SELECT column_id FROM kanban_cards WHERE id = ?').get(cardId) as
      | { column_id: string }
      | undefined
  )?.column_id;
}

describe('collapseReviewColumn', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('moves Review cards to In Progress and deletes the Review column', () => {
    addColumn(db, 'todo', 'b1', 'To Do', 0);
    addColumn(db, 'ip', 'b1', 'In Progress', 1);
    addColumn(db, 'rv', 'b1', 'Review', 2);
    addColumn(db, 'done', 'b1', 'Done', 3);
    addCard(db, 'a', 'b1', 'ip', 0); // existing In Progress card
    addCard(db, 'b', 'b1', 'rv', 0); // Review cards
    addCard(db, 'c', 'b1', 'rv', 1);

    const res = collapseReviewColumn(db);

    expect(res).toMatchObject({
      boardsScanned: 1,
      cardsMoved: 2,
      columnsDeleted: 1,
      boardsSkipped: 0,
    });
    expect(colNames(db, 'b1')).toEqual(['To Do', 'In Progress', 'Done']);
    expect(cardColumn(db, 'b')).toBe('ip');
    expect(cardColumn(db, 'c')).toBe('ip');
    // No cards lost to the cascade.
    expect((db.prepare('SELECT COUNT(*) AS n FROM kanban_cards').get() as { n: number }).n).toBe(3);
  });

  it('appends moved cards after existing In Progress cards (no position collision)', () => {
    addColumn(db, 'ip', 'b1', 'In Progress', 0);
    addColumn(db, 'rv', 'b1', 'Review', 1);
    addCard(db, 'a', 'b1', 'ip', 0);
    addCard(db, 'b', 'b1', 'ip', 1);
    addCard(db, 'r1', 'b1', 'rv', 0);
    addCard(db, 'r2', 'b1', 'rv', 1);

    collapseReviewColumn(db);

    const order = (
      db
        .prepare('SELECT id FROM kanban_cards WHERE column_id = ? ORDER BY position ASC')
        .all('ip') as Array<{ id: string }>
    ).map((c) => c.id);
    expect(order).toEqual(['a', 'b', 'r1', 'r2']);
  });

  it('re-packs column positions to close the gap left by Review', () => {
    addColumn(db, 'todo', 'b1', 'To Do', 0);
    addColumn(db, 'ip', 'b1', 'In Progress', 1);
    addColumn(db, 'rv', 'b1', 'Review', 2);
    addColumn(db, 'done', 'b1', 'Done', 3);

    collapseReviewColumn(db);

    const positions = (
      db
        .prepare('SELECT position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC')
        .all('b1') as Array<{ position: number }>
    ).map((c) => c.position);
    expect(positions).toEqual([0, 1, 2]);
  });

  it('drops an EMPTY Review column even when there is no In Progress target', () => {
    addColumn(db, 'todo', 'b1', 'To Do', 0);
    addColumn(db, 'rv', 'b1', 'Review', 1);

    const res = collapseReviewColumn(db);

    expect(res).toMatchObject({ cardsMoved: 0, columnsDeleted: 1, boardsSkipped: 0 });
    expect(colNames(db, 'b1')).toEqual(['To Do']);
  });

  it('leaves a NON-empty Review column intact when there is no In Progress target', () => {
    addColumn(db, 'todo', 'b1', 'To Do', 0);
    addColumn(db, 'rv', 'b1', 'Review', 1);
    addCard(db, 'x', 'b1', 'rv', 0);

    const res = collapseReviewColumn(db);

    expect(res).toMatchObject({ cardsMoved: 0, columnsDeleted: 0, boardsSkipped: 1 });
    expect(colNames(db, 'b1')).toContain('Review');
    expect(cardColumn(db, 'x')).toBe('rv'); // not orphaned
  });

  it('migrates each board independently and skips boards without Review', () => {
    // Board 1: has Review with a card + In Progress.
    addColumn(db, 'b1-ip', 'b1', 'In Progress', 0);
    addColumn(db, 'b1-rv', 'b1', 'Review', 1);
    addCard(db, 'b1c', 'b1', 'b1-rv', 0);
    // Board 2: no Review column at all.
    addColumn(db, 'b2-todo', 'b2', 'To Do', 0);
    addColumn(db, 'b2-ip', 'b2', 'In Progress', 1);

    const res = collapseReviewColumn(db);

    expect(res).toMatchObject({ boardsScanned: 1, cardsMoved: 1, columnsDeleted: 1 });
    expect(cardColumn(db, 'b1c')).toBe('b1-ip');
    expect(colNames(db, 'b2')).toEqual(['To Do', 'In Progress']);
  });

  it('is idempotent — a second run is a no-op', () => {
    addColumn(db, 'ip', 'b1', 'In Progress', 0);
    addColumn(db, 'rv', 'b1', 'Review', 1);
    addCard(db, 'r1', 'b1', 'rv', 0);

    collapseReviewColumn(db);
    const second = collapseReviewColumn(db);

    expect(second).toMatchObject({ boardsScanned: 0, cardsMoved: 0, columnsDeleted: 0 });
    expect(colNames(db, 'b1')).toEqual(['In Progress']);
  });

  it('does not bump updated_at on moved cards', () => {
    addColumn(db, 'ip', 'b1', 'In Progress', 0);
    addColumn(db, 'rv', 'b1', 'Review', 1);
    addCard(db, 'r1', 'b1', 'rv', 0, '2020-01-01 00:00:00');

    collapseReviewColumn(db);

    const updatedAt = (
      db.prepare('SELECT updated_at FROM kanban_cards WHERE id = ?').get('r1') as {
        updated_at: string;
      }
    ).updated_at;
    expect(updatedAt).toBe('2020-01-01 00:00:00');
  });
});
