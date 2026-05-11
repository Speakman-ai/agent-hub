/**
 * Regression / coverage test for the Backlog-column drop migration added in PR #885.
 *
 * The migration lives in server/db.ts (search for "Migration: drop the "Backlog"
 * column"). It has four non-trivial branches, all exercised here:
 *
 *   Board A — has both Backlog and To Do: Backlog cards move to the bottom of
 *     To Do (preserving intra-column order), Backlog column is deleted, and
 *     remaining column positions are repacked.
 *
 *   Board B — has Backlog but no To Do (documented fallback): Backlog is
 *     renamed "To Do" in place with the canonical color; no card movement.
 *
 *   Board C — has no Backlog at all (already-migrated or new board): columns
 *     and cards survive unchanged (idempotency / no-op branch).
 *
 * All three boards are seeded into the same SQLite file before initDb() runs,
 * matching production reality and avoiding the ESM-module-cache issue (a
 * subsequent import() in a later it() block returns the already-resolved
 * module and would not re-run initDb).
 *
 * Pattern mirrors server/test/db-webhook-events-migration.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import crypto from 'crypto';

/** Minimal DDL covering only the columns the migration actually touches. */
const KANBAN_DDL = `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE IF NOT EXISTS kanban_boards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kanban_columns (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    color TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kanban_cards (
    id TEXT PRIMARY KEY,
    column_id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    priority TEXT NOT NULL DEFAULT 'medium',
    assignee TEXT,
    labels TEXT,
    session_id TEXT,
    github_issue_url TEXT,
    created_by TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function uid(): string {
  return crypto.randomUUID();
}

describe('Backlog column drop migration', () => {
  // Seed all boards into the DB, import db.js once, then verify each board.
  // The three boards exercise the three main migration branches in a single
  // initDb() call (ESM module cache means only the first import() triggers it).

  // IDs seeded before the import — kept at describe scope so all it() blocks
  // can read them after the migration runs.
  let boardAId: string, todoAId: string, backlogAId: string;
  let todoACard1: string, todoACard2: string, backlogACard1: string, backlogACard2: string;

  let boardBId: string, backlogBId: string;
  let boardBCard1: string, boardBCard2: string;

  let boardCId: string, todoCId: string, inProgCId: string, boardCCardId: string;

  it('seeds boards, runs initDb, and verifies all migration branches', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');

    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(KANBAN_DDL);

    // ── Board A: Backlog + To Do ───────────────────────────────────────────
    // Expects: Backlog cards appended to To Do in order; Backlog column deleted.
    boardAId = uid();
    todoAId = uid();
    backlogAId = uid();
    seed
      .prepare(`INSERT INTO kanban_boards (id, project_id, name) VALUES (?, 'pA', 'Board A')`)
      .run(boardAId);
    seed
      .prepare(
        `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, 'To Do', 0)`,
      )
      .run(todoAId, boardAId);
    seed
      .prepare(
        `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, 'Backlog', 1)`,
      )
      .run(backlogAId, boardAId);

    todoACard1 = uid();
    todoACard2 = uid();
    backlogACard1 = uid();
    backlogACard2 = uid();
    const ins = seed.prepare(
      `INSERT INTO kanban_cards (id, column_id, board_id, title, position) VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run(todoACard1, todoAId, boardAId, 'Todo A1', 0);
    ins.run(todoACard2, todoAId, boardAId, 'Todo A2', 1);
    ins.run(backlogACard1, backlogAId, boardAId, 'Backlog A1', 0);
    ins.run(backlogACard2, backlogAId, boardAId, 'Backlog A2', 1);

    // ── Board B: Backlog only (no To Do) ──────────────────────────────────
    // Expects: Backlog renamed to "To Do" in place; cards stay in same column.
    boardBId = uid();
    backlogBId = uid();
    seed
      .prepare(`INSERT INTO kanban_boards (id, project_id, name) VALUES (?, 'pB', 'Board B')`)
      .run(boardBId);
    seed
      .prepare(
        `INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, 'Backlog', 0, '#888')`,
      )
      .run(backlogBId, boardBId);

    boardBCard1 = uid();
    boardBCard2 = uid();
    ins.run(boardBCard1, backlogBId, boardBId, 'B Card 1', 0);
    ins.run(boardBCard2, backlogBId, boardBId, 'B Card 2', 1);

    // ── Board C: No Backlog (already-migrated / fresh board) ─────────────
    // Expects: no changes — idempotency / no-op branch.
    boardCId = uid();
    todoCId = uid();
    inProgCId = uid();
    seed
      .prepare(`INSERT INTO kanban_boards (id, project_id, name) VALUES (?, 'pC', 'Board C')`)
      .run(boardCId);
    seed
      .prepare(
        `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, 'To Do', 0)`,
      )
      .run(todoCId, boardCId);
    seed
      .prepare(
        `INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, 'In Progress', 1)`,
      )
      .run(inProgCId, boardCId);

    boardCCardId = uid();
    ins.run(boardCCardId, todoCId, boardCId, 'C Card', 0);
    seed.close();

    // ── Run initDb ───────────────────────────────────────────────────────
    await expect(import('../db.js')).resolves.toBeDefined();

    const db = new Database(dbPath, { readonly: true });

    // ── Verify Board A ────────────────────────────────────────────────────
    const aCols = db
      .prepare(
        `SELECT id, name, position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC`,
      )
      .all(boardAId) as { id: string; name: string; position: number }[];

    // Backlog column gone; exactly one column remains.
    expect(aCols.map((c) => c.name)).not.toContain('Backlog');
    expect(aCols).toHaveLength(1);
    expect(aCols[0].name).toBe('To Do');
    // Position repacked from 0.
    expect(aCols[0].position).toBe(0);

    // All four cards now under To Do with correct relative ordering.
    const aCards = db
      .prepare(`SELECT id, position FROM kanban_cards WHERE column_id = ? ORDER BY position ASC`)
      .all(todoAId) as { id: string; position: number }[];
    const aIds = aCards.map((c) => c.id);
    expect(aIds).toHaveLength(4);
    expect(aIds).toContain(todoACard1);
    expect(aIds).toContain(todoACard2);
    expect(aIds).toContain(backlogACard1);
    expect(aIds).toContain(backlogACard2);

    // Original To Do order preserved; Backlog cards appended after in their order.
    expect(aIds.indexOf(todoACard1)).toBeLessThan(aIds.indexOf(todoACard2));
    expect(aIds.indexOf(todoACard2)).toBeLessThan(aIds.indexOf(backlogACard1));
    expect(aIds.indexOf(backlogACard1)).toBeLessThan(aIds.indexOf(backlogACard2));

    // ── Verify Board B ────────────────────────────────────────────────────
    const bCol = db
      .prepare(`SELECT id, name, color FROM kanban_columns WHERE id = ?`)
      .get(backlogBId) as { id: string; name: string; color: string } | undefined;

    // Backlog column was renamed to "To Do" with canonical color.
    expect(bCol).toBeDefined();
    expect(bCol?.name).toBe('To Do');
    expect(bCol?.color).toBe('#3B82F6');

    // Cards remain in the same (now-renamed) column.
    const bCards = db
      .prepare(`SELECT id FROM kanban_cards WHERE column_id = ?`)
      .all(backlogBId) as { id: string }[];
    expect(bCards.map((c) => c.id)).toContain(boardBCard1);
    expect(bCards.map((c) => c.id)).toContain(boardBCard2);

    // ── Verify Board C ────────────────────────────────────────────────────
    const cCols = db
      .prepare(`SELECT name FROM kanban_columns WHERE board_id = ? ORDER BY position ASC`)
      .all(boardCId) as { name: string }[];
    expect(cCols.map((c) => c.name)).toEqual(['To Do', 'In Progress']);

    const cCard = db
      .prepare(`SELECT column_id FROM kanban_cards WHERE id = ?`)
      .get(boardCCardId) as { column_id: string } | undefined;
    expect(cCard?.column_id).toBe(todoCId);

    db.close();
  });
});
