import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  KANBAN_CARD_SHORT_ID_TRIGGER_SQL,
  KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL,
} from './kanban-short-id.js';

/**
 * Focused regression coverage for the card_seq self-healing reconcile.
 *
 * Reproduces the reviewer's interruption scenario: an earlier, non-atomic
 * backfill could commit `kanban_cards.short_id` but die before advancing
 * `kanban_boards.card_seq`. On the next startup the backfill block is skipped
 * (no NULL short_ids remain) and, without the unconditional reconcile, card_seq
 * stays 0 — so the assign-on-insert trigger mints short_id=1 again, duplicating
 * an existing human id. Builds a minimal DB from the SAME shared SQL the
 * migration uses, so the trigger + reconcile under test are the real ones.
 */

let db: Database.Database;

function insertCard(id: string, boardId: string, shortId: number | null): void {
  db.prepare(
    'INSERT INTO kanban_cards (id, board_id, short_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, boardId, shortId, '2026-01-01T00:00:00Z');
}

function shortIdOf(id: string): number | null {
  return (
    db.prepare('SELECT short_id FROM kanban_cards WHERE id = ?').get(id) as {
      short_id: number | null;
    }
  ).short_id;
}

function cardSeqOf(boardId: string): number {
  return (
    db.prepare('SELECT card_seq FROM kanban_boards WHERE id = ?').get(boardId) as {
      card_seq: number;
    }
  ).card_seq;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE kanban_boards (
      id TEXT PRIMARY KEY,
      card_seq INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      short_id INTEGER,
      created_at TEXT
    );
  `);
  db.exec(KANBAN_CARD_SHORT_ID_TRIGGER_SQL);
});

afterEach(() => {
  db.close();
});

describe('card_seq reconcile (self-healing)', () => {
  it('repairs a card_seq stranded at 0 by an interrupted backfill', () => {
    // Corrupted state: short_ids assigned, but card_seq never advanced.
    db.prepare('INSERT INTO kanban_boards (id, card_seq) VALUES (?, 0)').run('b1');
    insertCard('c1', 'b1', 1);
    insertCard('c2', 'b1', 2);
    expect(cardSeqOf('b1')).toBe(0);

    db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);
    expect(cardSeqOf('b1')).toBe(2);

    // The next inserted card must NOT collide with the existing short_ids.
    insertCard('c3', 'b1', null); // trigger assigns
    expect(shortIdOf('c3')).toBe(3);
    const all = db
      .prepare('SELECT short_id FROM kanban_cards WHERE board_id = ?')
      .all('b1') as Array<{
      short_id: number;
    }>;
    const ids = all.map((r) => r.short_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it('only ever raises card_seq — never lowers it after deletes', () => {
    // card_seq is ahead of MAX(short_id) because higher-numbered cards were
    // deleted. Reconcile must leave it alone so retired numbers are not reused.
    db.prepare('INSERT INTO kanban_boards (id, card_seq) VALUES (?, 10)').run('b1');
    insertCard('c1', 'b1', 3);

    db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);
    expect(cardSeqOf('b1')).toBe(10);

    insertCard('c2', 'b1', null);
    expect(shortIdOf('c2')).toBe(11);
  });

  it('is a no-op for an empty board and is idempotent', () => {
    db.prepare('INSERT INTO kanban_boards (id, card_seq) VALUES (?, 0)').run('b1');

    db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);
    db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);
    expect(cardSeqOf('b1')).toBe(0);

    insertCard('c1', 'b1', null);
    expect(shortIdOf('c1')).toBe(1);
  });

  it('reconciles each board independently', () => {
    db.prepare('INSERT INTO kanban_boards (id, card_seq) VALUES (?, 0)').run('b1');
    db.prepare('INSERT INTO kanban_boards (id, card_seq) VALUES (?, 0)').run('b2');
    insertCard('a1', 'b1', 1);
    insertCard('a2', 'b1', 2);
    insertCard('b1c1', 'b2', 1);

    db.exec(KANBAN_BOARD_CARD_SEQ_RECONCILE_SQL);
    expect(cardSeqOf('b1')).toBe(2);
    expect(cardSeqOf('b2')).toBe(1);
  });
});
