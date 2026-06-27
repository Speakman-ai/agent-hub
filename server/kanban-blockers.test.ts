/**
 * Unit tests for the blockers helper module. These cover the pure logic
 * (column-name matching, cycle detection) against a fresh in-memory
 * SQLite database — no HTTP layer required.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  findCycle,
  hasUnresolvedBlockers,
  isColumnBlockerSensitive,
  isColumnDone,
  isSystemLockedColumnName,
  isColumnShippedLane,
  loadBoardBlockers,
} from './kanban-blockers.js';
import type { Stmts } from './types.js';

// ─── In-memory DB scaffolding ──────────────────────────────────────────────
//
// The helper only ever touches four statements. Building a minimal fake
// `Stmts` keeps these tests fast and decoupled from the real prepare() wiring
// in db.ts — if that file grows new columns, these tests stay green.

interface TestStmts {
  getBlockersForCard: { all: (cardId: string) => Array<{ blocked_by_card_id: string }> };
  getBlockersForBoard: { all: (boardId: string) => unknown[] };
}

function makeStmts(db: Database.Database): TestStmts {
  return {
    getBlockersForCard: db.prepare(
      'SELECT blocked_by_card_id FROM kanban_card_blockers WHERE card_id = ?',
    ) as unknown as TestStmts['getBlockersForCard'],
    getBlockersForBoard: db.prepare(
      `SELECT b.card_id AS card_id,
              b.blocked_by_card_id AS blocked_by_card_id,
              blocker.id AS blocker_id,
              blocker.title AS blocker_title,
              blocker.column_id AS blocker_column_id,
              blocker_col.name AS blocker_column_name,
              blocked.id AS blocked_id,
              blocked.title AS blocked_title,
              blocked.column_id AS blocked_column_id,
              blocked_col.name AS blocked_column_name
       FROM kanban_card_blockers b
       JOIN kanban_cards blocker ON b.blocked_by_card_id = blocker.id
       JOIN kanban_columns blocker_col ON blocker.column_id = blocker_col.id
       JOIN kanban_cards blocked ON b.card_id = blocked.id
       JOIN kanban_columns blocked_col ON blocked.column_id = blocked_col.id
       WHERE blocker.board_id = ?`,
    ) as unknown as TestStmts['getBlockersForBoard'],
  };
}

function buildDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, name TEXT NOT NULL, board_id TEXT NOT NULL);
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL
    );
    CREATE TABLE kanban_card_blockers (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      blocked_by_card_id TEXT NOT NULL,
      UNIQUE(card_id, blocked_by_card_id)
    );
  `);
  return db;
}

function seedBoard(
  db: Database.Database,
  boardId: string,
  cards: Array<{ id: string; columnName: string }>,
): void {
  const colInsert = db.prepare('INSERT INTO kanban_columns (id, name, board_id) VALUES (?, ?, ?)');
  const cardInsert = db.prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)',
  );
  const cols = new Map<string, string>();
  for (const { columnName } of cards) {
    if (!cols.has(columnName)) {
      // Scope IDs by board to keep multi-board test setups collision-free.
      const id = `col-${boardId}-${columnName}`;
      colInsert.run(id, columnName, boardId);
      cols.set(columnName, id);
    }
  }
  for (const { id, columnName } of cards) {
    cardInsert.run(id, cols.get(columnName) as string, boardId, `Card ${id}`);
  }
}

function link(db: Database.Database, cardId: string, blockedBy: string): void {
  db.prepare(
    'INSERT INTO kanban_card_blockers (id, card_id, blocked_by_card_id) VALUES (?, ?, ?)',
  ).run(`link-${cardId}-${blockedBy}`, cardId, blockedBy);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('isColumnDone', () => {
  it('matches exact "Done"', () => {
    expect(isColumnDone('Done')).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isColumnDone('DONE')).toBe(true);
    expect(isColumnDone('done')).toBe(true);
  });
  it('matches substrings like "Deployed / Done"', () => {
    expect(isColumnDone('Deployed / Done')).toBe(true);
    expect(isColumnDone('Done ✅')).toBe(true);
  });
  it('does NOT match non-done columns', () => {
    expect(isColumnDone('In Progress')).toBe(false);
    expect(isColumnDone('To Do')).toBe(false);
    expect(isColumnDone('Backlog')).toBe(false);
    expect(isColumnDone('Review')).toBe(false);
  });
  it('handles null/undefined/empty', () => {
    expect(isColumnDone(null)).toBe(false);
    expect(isColumnDone(undefined)).toBe(false);
    expect(isColumnDone('')).toBe(false);
  });
});

describe('isSystemLockedColumnName', () => {
  it('locks the default automation columns', () => {
    expect(isSystemLockedColumnName('To Do')).toBe(true);
    expect(isSystemLockedColumnName('In Progress')).toBe(true);
    expect(isSystemLockedColumnName('Done')).toBe(true);
  });

  it('does not lock custom or substring Done lanes', () => {
    expect(isSystemLockedColumnName('QA')).toBe(false);
    expect(isSystemLockedColumnName('Review')).toBe(false);
    expect(isSystemLockedColumnName('Deployed / Done')).toBe(false);
  });
});

describe('isColumnShippedLane', () => {
  it('matches standalone Shipped labels (case-insensitive)', () => {
    expect(isColumnShippedLane('Shipped')).toBe(true);
    expect(isColumnShippedLane('shipped')).toBe(true);
    expect(isColumnShippedLane('SHIPPED')).toBe(true);
  });
  it('matches shipped as its own word inside a longer lane name', () => {
    expect(isColumnShippedLane('Staging Shipped')).toBe(true);
    expect(isColumnShippedLane('Pre-shipped')).toBe(true);
  });
  it('does NOT match Unshipped (still in-flight work)', () => {
    expect(isColumnShippedLane('Unshipped')).toBe(false);
    expect(isColumnShippedLane('unshipped')).toBe(false);
  });
  it('does NOT match substring shipped without a word boundary', () => {
    expect(isColumnShippedLane('misshipped')).toBe(false);
  });
  it('handles null/undefined/empty', () => {
    expect(isColumnShippedLane(null)).toBe(false);
    expect(isColumnShippedLane(undefined)).toBe(false);
    expect(isColumnShippedLane('')).toBe(false);
  });
});

describe('isColumnBlockerSensitive', () => {
  it('is false for Done variants', () => {
    expect(isColumnBlockerSensitive('Done')).toBe(false);
    expect(isColumnBlockerSensitive('done')).toBe(false);
    expect(isColumnBlockerSensitive('Deployed / Done')).toBe(false);
  });
  it('is false for "Backlog" as back-compat for custom boards (default seed no longer includes it)', () => {
    // The default board now starts at "To Do" — Backlog was removed. But
    // operators may still have custom boards carrying a Backlog column, and
    // the predicate keeps treating that lane as blocker-insensitive so the
    // confirm dialog doesn't fire when dragging cards back into it.
    expect(isColumnBlockerSensitive('Backlog')).toBe(false);
    expect(isColumnBlockerSensitive('backlog')).toBe(false);
    expect(isColumnBlockerSensitive('Project Backlog')).toBe(false);
  });
  it('is true for every other column', () => {
    expect(isColumnBlockerSensitive('To Do')).toBe(true);
    expect(isColumnBlockerSensitive('In Progress')).toBe(true);
    expect(isColumnBlockerSensitive('Review')).toBe(true);
    expect(isColumnBlockerSensitive('Blocked')).toBe(true);
    expect(isColumnBlockerSensitive('Custom Column')).toBe(true);
  });
});

describe('findCycle', () => {
  let db: Database.Database;
  let stmts: Stmts;

  beforeEach(() => {
    db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'A', columnName: 'To Do' },
      { id: 'B', columnName: 'To Do' },
      { id: 'C', columnName: 'To Do' },
      { id: 'D', columnName: 'To Do' },
      { id: 'E', columnName: 'To Do' },
    ]);
    stmts = makeStmts(db) as unknown as Stmts;
  });

  it('rejects trivial self-blocks', () => {
    const cycle = findCycle(stmts, 'A', 'A');
    expect(cycle).toEqual(['A', 'A']);
  });

  it('accepts independent edges', () => {
    expect(findCycle(stmts, 'A', 'B')).toBeNull();
  });

  it('detects 2-node cycle (A blocked by B; adding B blocked by A)', () => {
    link(db, 'A', 'B'); // A is blocked by B
    // Now propose: B is blocked by A. That would close a 2-cycle.
    const cycle = findCycle(stmts, 'B', 'A');
    expect(cycle).not.toBeNull();
    // Path should name both nodes.
    expect(cycle).toEqual(['B', 'A', 'B']);
  });

  it('detects 3-node cycle', () => {
    // A ← B ← C, adding C ← A closes cycle A → C → B → A? Wait,
    // edges mean "card_id is blocked by blocked_by_card_id", so link(X,Y)
    // means X is blocked by Y, i.e. Y must finish before X. Walking
    // `blocked_by_card_id` goes "upstream" — toward work that must happen
    // first. So link(A,B) + link(B,C): A depends on B, B depends on C.
    // Now proposing link(C,A) would mean C depends on A, completing a cycle.
    link(db, 'A', 'B');
    link(db, 'B', 'C');
    const cycle = findCycle(stmts, 'C', 'A');
    expect(cycle).not.toBeNull();
    // Path starts and ends at C (the card receiving the new edge).
    expect(cycle?.[0]).toBe('C');
    expect(cycle?.[cycle.length - 1]).toBe('C');
  });

  it('detects N-node cycle (chain of 5)', () => {
    link(db, 'A', 'B');
    link(db, 'B', 'C');
    link(db, 'C', 'D');
    link(db, 'D', 'E');
    // Now link(E, A) would cycle through all 5 nodes.
    const cycle = findCycle(stmts, 'E', 'A');
    expect(cycle).not.toBeNull();
    expect(cycle?.length).toBeGreaterThan(3);
  });

  it('allows diamond (shared upstream) without a cycle', () => {
    // B and C both depend on D. A depends on both B and C.
    //    A
    //   / \
    //  B   C
    //   \ /
    //    D
    link(db, 'A', 'B');
    link(db, 'A', 'C');
    link(db, 'B', 'D');
    link(db, 'C', 'D');
    // No cycle yet.
    expect(findCycle(stmts, 'A', 'D')).toBeNull();
  });

  it('detects cycle through a diamond', () => {
    link(db, 'A', 'B');
    link(db, 'B', 'C');
    link(db, 'A', 'D');
    link(db, 'D', 'C');
    // Proposing link(C, A) completes a cycle via either branch.
    expect(findCycle(stmts, 'C', 'A')).not.toBeNull();
  });
});

describe('loadBoardBlockers + hasUnresolvedBlockers', () => {
  it('returns empty maps for a board with no edges', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [{ id: 'A', columnName: 'To Do' }]);
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(idx.blockersByCard.size).toBe(0);
    expect(idx.blocksByCard.size).toBe(0);
    expect(hasUnresolvedBlockers('A', idx)).toBe(false);
  });

  it('indexes both directions of each edge', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'A', columnName: 'To Do' },
      { id: 'B', columnName: 'To Do' },
    ]);
    link(db, 'A', 'B');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    // A has one blocker (B).
    expect(idx.blockersByCard.get('A')).toHaveLength(1);
    expect(idx.blockersByCard.get('A')?.[0]?.id).toBe('B');
    // B blocks one card (A).
    expect(idx.blocksByCard.get('B')).toHaveLength(1);
    expect(idx.blocksByCard.get('B')?.[0]?.id).toBe('A');
  });

  it('marks blockers in a Done column as done:true', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'A', columnName: 'In Progress' },
      { id: 'B', columnName: 'Done' },
    ]);
    link(db, 'A', 'B');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(idx.blockersByCard.get('A')?.[0]?.done).toBe(true);
    expect(hasUnresolvedBlockers('A', idx)).toBe(false);
  });

  it('marks blockers in a non-Done column as done:false', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'A', columnName: 'In Progress' },
      { id: 'B', columnName: 'In Progress' },
    ]);
    link(db, 'A', 'B');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(idx.blockersByCard.get('A')?.[0]?.done).toBe(false);
    expect(hasUnresolvedBlockers('A', idx)).toBe(true);
  });

  it('card with mixed done and non-done blockers is still unresolved', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'A', columnName: 'To Do' },
      { id: 'B', columnName: 'Done' },
      { id: 'C', columnName: 'In Progress' },
    ]);
    link(db, 'A', 'B');
    link(db, 'A', 'C');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(idx.blockersByCard.get('A')).toHaveLength(2);
    expect(hasUnresolvedBlockers('A', idx)).toBe(true);
  });

  // ─── AC coverage — autonomous dispatcher eligibility predicate ──────────
  //
  // The four cases below map 1:1 to the acceptance criteria from the
  // "Autonomous mode does not handle blockers well" ticket. They cover the
  // exact predicate the dispatcher consults — `hasUnresolvedBlockers` — so
  // a regression there immediately surfaces as a named test failure.

  it('AC: card with no blockers is eligible', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [{ id: 'solo', columnName: 'To Do' }]);
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(hasUnresolvedBlockers('solo', idx)).toBe(false);
  });

  it('AC: card whose every blocker is Done is eligible', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'target', columnName: 'To Do' },
      { id: 'up1', columnName: 'Done' },
      { id: 'up2', columnName: 'Done ✅' },
    ]);
    link(db, 'target', 'up1');
    link(db, 'target', 'up2');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(hasUnresolvedBlockers('target', idx)).toBe(false);
  });

  it('AC: card with any blocker not-Done is ineligible', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [
      { id: 'target', columnName: 'To Do' },
      { id: 'up1', columnName: 'Done' },
      { id: 'up2', columnName: 'In Progress' }, // not Done
    ]);
    link(db, 'target', 'up1');
    link(db, 'target', 'up2');
    const stmts = makeStmts(db) as unknown as Stmts;
    const idx = loadBoardBlockers(stmts, 'b1');
    expect(hasUnresolvedBlockers('target', idx)).toBe(true);
  });

  it('AC: every Done-column variant resolves blockers', () => {
    // The bug report flagged that operators rename "Done" freely. Each
    // variant must count as resolved so renames don't strand the loop.
    for (const variant of ['Done', 'Done ✅', 'Deployed / Done', 'DONE', 'done']) {
      const db = buildDb();
      seedBoard(db, 'b1', [
        { id: 'target', columnName: 'To Do' },
        { id: 'upstream', columnName: variant },
      ]);
      link(db, 'target', 'upstream');
      const stmts = makeStmts(db) as unknown as Stmts;
      const idx = loadBoardBlockers(stmts, 'b1');
      expect(hasUnresolvedBlockers('target', idx)).toBe(false);
    }
  });

  it('does not leak edges across boards', () => {
    const db = buildDb();
    seedBoard(db, 'b1', [{ id: 'A', columnName: 'To Do' }]);
    seedBoard(db, 'b2', [{ id: 'B', columnName: 'To Do' }]);
    // Cross-board edges shouldn't exist in practice (the POST endpoint
    // rejects them), but guard against a stray row.
    link(db, 'A', 'B');
    const stmts = makeStmts(db) as unknown as Stmts;
    // Query each board separately — the blocker CARD lives on b1, so the
    // query keyed off blocker.board_id returns the edge only under b1.
    const idx1 = loadBoardBlockers(stmts, 'b1');
    // A's blocker is on b2, so when we query by blocker.board_id=b1 the
    // edge shouldn't appear. (The query filters on blocker.board_id.)
    expect(idx1.blockersByCard.size).toBe(0);
    const idx2 = loadBoardBlockers(stmts, 'b2');
    expect(idx2.blocksByCard.get('B')).toHaveLength(1);
  });
});
