/**
 * Regression test for the Backlog-column-drop migration in `server/db.ts`.
 *
 * The migration is non-trivial and has four behaviorally distinct branches
 * that all need to be exercised here:
 *
 *   1. Board has Backlog AND To Do  → cards move (in position order) to the
 *      bottom of To Do, then the Backlog column is deleted and remaining
 *      columns are re-packed (positions 0..n-1, no gaps).
 *   2. Board has Backlog BUT NO To Do → Backlog is renamed in place to
 *      "To Do" (no card moves). This is the documented fallback.
 *   3. Board has no Backlog at all   → board is untouched (no-op).
 *   4. Idempotency: re-importing `db.ts` on the post-migration DB finds no
 *      Backlog rows and exits the branch early. Nothing else changes.
 *
 * Test approach mirrors `db-webhook-events-migration.test.ts` — seed a
 * pre-migration kanban schema on disk BEFORE importing `db.ts`, then
 * import (which runs the boot-time migration), then assert via a fresh
 * read-only connection.
 *
 * NOTE: the migration MATCHES `name = 'Backlog'` with exact case, so a
 * custom column literally named "Backlog" on a user board would be
 * affected. Columns whose names merely *contain* "backlog" (e.g.
 * "Project Backlog") are preserved — that's the substring back-compat
 * separately tested in `kanban-blockers.test.ts`. This test asserts the
 * exact-case behavior directly.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

function seedPreMigrationSchema(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  // Schema kept intentionally minimal — just enough for the migration's
  // SELECTs/UPDATEs/DELETEs to operate. db.ts will CREATE TABLE IF NOT
  // EXISTS on top of these (no-op) before running the migration body.
  seed.exec(`
    CREATE TABLE kanban_boards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE kanban_columns (
      id TEXT PRIMARY KEY,
      board_id TEXT NOT NULL,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      color TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      column_id TEXT NOT NULL,
      board_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      assignee TEXT,
      labels TEXT,
      session_id TEXT,
      github_issue_url TEXT,
      created_by TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (column_id) REFERENCES kanban_columns(id) ON DELETE CASCADE,
      FOREIGN KEY (board_id) REFERENCES kanban_boards(id) ON DELETE CASCADE
    );
  `);

  const insertBoard = seed.prepare(
    'INSERT INTO kanban_boards (id, project_id, name) VALUES (?, ?, ?)',
  );
  const insertCol = seed.prepare(
    'INSERT INTO kanban_columns (id, board_id, name, position, color) VALUES (?, ?, ?, ?, ?)',
  );
  const insertCard = seed.prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title, position) VALUES (?, ?, ?, ?, ?)',
  );

  // ── Board A: Backlog + To Do both present (branch 1) ────────────────────
  // Pre-migration column order: Backlog(0), To Do(1), In Progress(2), Done(3)
  // Backlog has 2 cards (positions 0,1). To Do has 1 card (position 0).
  // Expected after migration:
  //   - Backlog cards appended to To Do at positions 1, 2 (after the
  //     existing To Do card at position 0).
  //   - Backlog column row deleted.
  //   - Remaining columns re-packed to positions 0..2.
  insertBoard.run('board-a', 'proj-a', 'Board A');
  insertCol.run('col-a-backlog', 'board-a', 'Backlog', 0, '#6B7280');
  insertCol.run('col-a-todo', 'board-a', 'To Do', 1, '#3B82F6');
  insertCol.run('col-a-progress', 'board-a', 'In Progress', 2, '#F59E0B');
  insertCol.run('col-a-done', 'board-a', 'Done', 3, '#10B981');
  insertCard.run('card-a-bl-1', 'col-a-backlog', 'board-a', 'Backlog card 1', 0);
  insertCard.run('card-a-bl-2', 'col-a-backlog', 'board-a', 'Backlog card 2', 1);
  insertCard.run('card-a-td-1', 'col-a-todo', 'board-a', 'Existing To Do card', 0);

  // ── Board B: Backlog with NO To Do (branch 2 — rename in place) ─────────
  // The migration should rename the column from 'Backlog' to 'To Do' and
  // keep its single card untouched.
  insertBoard.run('board-b', 'proj-b', 'Board B');
  insertCol.run('col-b-backlog', 'board-b', 'Backlog', 0, '#6B7280');
  insertCol.run('col-b-progress', 'board-b', 'In Progress', 1, '#F59E0B');
  insertCol.run('col-b-done', 'board-b', 'Done', 2, '#10B981');
  insertCard.run('card-b-bl-1', 'col-b-backlog', 'board-b', 'Lone Backlog card', 0);

  // ── Board C: no Backlog column at all (branch 3 — no-op / untouched) ───
  insertBoard.run('board-c', 'proj-c', 'Board C');
  insertCol.run('col-c-todo', 'board-c', 'To Do', 0, '#3B82F6');
  insertCol.run('col-c-done', 'board-c', 'Done', 1, '#10B981');
  insertCard.run('card-c-td-1', 'col-c-todo', 'board-c', 'Untouched card', 0);

  // ── Board D: column literally named "Project Backlog" (substring, not exact) ─
  // Migration uses `name = 'Backlog'` with exact case-sensitive equality,
  // so this column must survive unchanged. Locks in the
  // exact-vs-substring contract documented in the wiki.
  insertBoard.run('board-d', 'proj-d', 'Board D');
  insertCol.run('col-d-projbl', 'board-d', 'Project Backlog', 0, '#6B7280');
  insertCol.run('col-d-done', 'board-d', 'Done', 1, '#10B981');

  seed.close();
}

describe('kanban Backlog-drop migration', () => {
  it('moves Backlog cards into To Do, drops Backlog, renames in fallback, and is idempotent', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }
    const dbPath = path.join(dataDir, 'agent-hub.db');

    // 1. Seed the four-board pre-migration state on disk.
    seedPreMigrationSchema(dbPath);

    // 2. Import db.ts — module-load triggers initDb(config.dataDir), which
    //    executes the Backlog migration body.
    await expect(import('../db.js')).resolves.toBeDefined();

    // 3. Inspect the resulting state via a fresh read-only connection.
    const verify = new Database(dbPath, { readonly: true });

    // ── Board A: Backlog merged into To Do ─────────────────────────────
    const boardACols = verify
      .prepare('SELECT name, position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC')
      .all('board-a') as { name: string; position: number }[];
    expect(boardACols.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
    // Positions must be re-packed to 0..2 (no gap left by the deleted Backlog).
    expect(boardACols.map((c) => c.position)).toEqual([0, 1, 2]);

    // The Backlog column row itself is gone.
    const boardABacklog = verify
      .prepare("SELECT id FROM kanban_columns WHERE board_id = ? AND name = 'Backlog'")
      .get('board-a');
    expect(boardABacklog).toBeUndefined();

    // All three cards are now in To Do, ordered: existing To Do card first
    // (position 0), then the two Backlog cards in their original intra-Backlog
    // order (positions 1 and 2).
    const todoColA = verify
      .prepare("SELECT id FROM kanban_columns WHERE board_id = ? AND name = 'To Do'")
      .get('board-a') as { id: string };
    const todoCards = verify
      .prepare('SELECT id, title, position FROM kanban_cards WHERE column_id = ? ORDER BY position')
      .all(todoColA.id) as { id: string; title: string; position: number }[];
    expect(todoCards).toEqual([
      { id: 'card-a-td-1', title: 'Existing To Do card', position: 0 },
      { id: 'card-a-bl-1', title: 'Backlog card 1', position: 1 },
      { id: 'card-a-bl-2', title: 'Backlog card 2', position: 2 },
    ]);

    // ── Board B: Backlog renamed in place (no To Do existed) ───────────
    const boardBCols = verify
      .prepare(
        'SELECT id, name, position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC',
      )
      .all('board-b') as { id: string; name: string; position: number }[];
    expect(boardBCols.map((c) => c.name)).toEqual(['To Do', 'In Progress', 'Done']);
    expect(boardBCols.map((c) => c.position)).toEqual([0, 1, 2]);
    // The renamed column must keep its original id so the lone card is still attached.
    const renamedTodo = boardBCols.find((c) => c.name === 'To Do');
    expect(renamedTodo?.id).toBe('col-b-backlog');
    const cardB = verify
      .prepare('SELECT column_id, position FROM kanban_cards WHERE id = ?')
      .get('card-b-bl-1') as { column_id: string; position: number };
    expect(cardB).toEqual({ column_id: 'col-b-backlog', position: 0 });

    // ── Board C: no Backlog at all — untouched ─────────────────────────
    const boardCCols = verify
      .prepare('SELECT name, position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC')
      .all('board-c') as { name: string; position: number }[];
    expect(boardCCols.map((c) => c.name)).toEqual(['To Do', 'Done']);
    expect(boardCCols.map((c) => c.position)).toEqual([0, 1]);
    const cardC = verify
      .prepare('SELECT column_id, position FROM kanban_cards WHERE id = ?')
      .get('card-c-td-1') as { column_id: string; position: number };
    expect(cardC).toEqual({ column_id: 'col-c-todo', position: 0 });

    // ── Board D: "Project Backlog" survives the exact-case filter ──────
    const boardDCols = verify
      .prepare(
        'SELECT id, name, position FROM kanban_columns WHERE board_id = ? ORDER BY position ASC',
      )
      .all('board-d') as { id: string; name: string; position: number }[];
    expect(boardDCols.map((c) => c.name)).toEqual(['Project Backlog', 'Done']);
    expect(boardDCols.find((c) => c.name === 'Project Backlog')?.id).toBe('col-d-projbl');

    // ── Idempotency: no Backlog-named columns remain board-wide ────────
    const remainingBacklog = verify
      .prepare("SELECT COUNT(*) AS n FROM kanban_columns WHERE name = 'Backlog'")
      .get() as { n: number };
    expect(remainingBacklog.n).toBe(0);

    verify.close();
  });
});
