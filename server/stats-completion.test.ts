import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { installStatsCompletionTimestamps } from './stats-completion.js';

/**
 * Regression coverage for the completion/resolution timestamp triggers +
 * backfill that back the per-project Stats page. Builds a minimal in-memory DB
 * WITHOUT the completion columns, so installStatsCompletionTimestamps exercises
 * the real ALTER + trigger + backfill path (byte-identical to db.ts init).
 */

let db: Database.Database;

function makeSchema(): void {
  // Mirrors the columns the installer's indexes reference (board_id/created_at
  // on cards, board_id on epics, project_id on tickets, plus messages +
  // pull_requests), matching the real tables present when db.ts calls the
  // installer after bootstrap.
  db.exec(`
    CREATE TABLE kanban_columns (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE kanban_cards (
      id TEXT PRIMARY KEY,
      board_id TEXT,
      column_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE kanban_epics (
      id TEXT PRIMARY KEY,
      board_id TEXT,
      state TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE support_tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE pull_requests (
      id TEXT PRIMARY KEY, project_id TEXT, status TEXT, merged_at INTEGER
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT);
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT, model TEXT, created_at TEXT
    );
    INSERT INTO kanban_columns (id, name) VALUES
      ('todo', 'To Do'), ('prog', 'In Progress'),
      ('done', 'Done'), ('done2', 'Deployed / Done');
  `);
}

function cardCompletedAt(id: string): string | null {
  return (
    db.prepare('SELECT completed_at FROM kanban_cards WHERE id = ?').get(id) as {
      completed_at: string | null;
    }
  ).completed_at;
}
function epicCompletedAt(id: string): string | null {
  return (
    db.prepare('SELECT completed_at FROM kanban_epics WHERE id = ?').get(id) as {
      completed_at: string | null;
    }
  ).completed_at;
}
function ticketResolvedAt(id: string): string | null {
  return (
    db.prepare('SELECT resolved_at FROM support_tickets WHERE id = ?').get(id) as {
      resolved_at: string | null;
    }
  ).resolved_at;
}

afterEach(() => db.close());

describe('installStatsCompletionTimestamps — backfill', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    makeSchema();
    // Legacy rows inserted BEFORE the migration runs.
    db.prepare(
      "INSERT INTO kanban_cards (id, column_id, updated_at) VALUES ('c-done', 'done', '2026-01-02 03:04:05')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_cards (id, column_id, updated_at) VALUES ('c-open', 'prog', '2026-01-02 03:04:05')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_epics (id, state, updated_at) VALUES ('e-done', 'done', '2026-02-03 00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_epics (id, state, updated_at) VALUES ('e-prog', 'in_progress', '2026-02-03 00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO support_tickets (id, status, updated_at) VALUES ('t-closed', 'closed', '2026-03-04 00:00:00')",
    ).run();
    db.prepare(
      "INSERT INTO support_tickets (id, status, updated_at) VALUES ('t-open', 'investigating', '2026-03-04 00:00:00')",
    ).run();
    installStatsCompletionTimestamps(db);
  });

  it('backfills completed_at/resolved_at from updated_at for terminal rows only', () => {
    expect(cardCompletedAt('c-done')).toBe('2026-01-02 03:04:05');
    expect(cardCompletedAt('c-open')).toBeNull();
    expect(epicCompletedAt('e-done')).toBe('2026-02-03 00:00:00');
    expect(epicCompletedAt('e-prog')).toBeNull();
    expect(ticketResolvedAt('t-closed')).toBe('2026-03-04 00:00:00');
    expect(ticketResolvedAt('t-open')).toBeNull();
  });

  it('runs the backfill once per DB — a cleared stamp is NOT re-stamped on re-init', () => {
    // Simulate a stamp that was correctly cleared after the initial backfill
    // (e.g. the row was reopened/reclosed, or manually nulled). A second init
    // must leave it NULL, not resurrect it from updated_at.
    db.prepare("UPDATE kanban_cards SET completed_at = NULL WHERE id = 'c-done'").run();
    db.prepare("UPDATE support_tickets SET resolved_at = NULL WHERE id = 't-closed'").run();

    installStatsCompletionTimestamps(db); // re-init (marker already present)

    expect(cardCompletedAt('c-done')).toBeNull();
    expect(ticketResolvedAt('t-closed')).toBeNull();
  });
});

describe('installStatsCompletionTimestamps — ALTER error handling', () => {
  it('rethrows non-duplicate-column errors (e.g. a missing table)', () => {
    db = new Database(':memory:');
    // Only kanban_cards exists; kanban_epics/support_tickets are absent, so the
    // second ALTER hits "no such table" — a real error that must NOT be
    // swallowed as if it were a duplicate-column no-op.
    db.exec(
      "CREATE TABLE kanban_cards (id TEXT PRIMARY KEY, column_id TEXT, updated_at TEXT DEFAULT (datetime('now')));",
    );
    expect(() => installStatsCompletionTimestamps(db)).toThrow(/no such table/i);
  });
});

describe('completion triggers', () => {
  beforeEach(() => {
    db = new Database(':memory:');
    makeSchema();
    installStatsCompletionTimestamps(db);
  });

  it('stamps card completed_at on move into a Done column and clears on move out', () => {
    db.prepare("INSERT INTO kanban_cards (id, column_id) VALUES ('c1', 'todo')").run();
    expect(cardCompletedAt('c1')).toBeNull();

    db.prepare("UPDATE kanban_cards SET column_id = 'done' WHERE id = 'c1'").run();
    expect(cardCompletedAt('c1')).not.toBeNull();

    db.prepare("UPDATE kanban_cards SET column_id = 'prog' WHERE id = 'c1'").run();
    expect(cardCompletedAt('c1')).toBeNull();
  });

  it('preserves the original completed_at when moving between two Done columns', () => {
    db.prepare("INSERT INTO kanban_cards (id, column_id) VALUES ('c2', 'done')").run();
    // Force a known sentinel, then move done → done: COALESCE must keep it.
    db.prepare(
      "UPDATE kanban_cards SET completed_at = '2020-05-05 05:05:05' WHERE id = 'c2'",
    ).run();
    db.prepare("UPDATE kanban_cards SET column_id = 'done2' WHERE id = 'c2'").run();
    expect(cardCompletedAt('c2')).toBe('2020-05-05 05:05:05');
  });

  it('stamps card completed_at on INSERT directly into a Done column', () => {
    db.prepare("INSERT INTO kanban_cards (id, column_id) VALUES ('c3', 'done2')").run();
    expect(cardCompletedAt('c3')).not.toBeNull();
  });

  it('stamps epic completed_at on state=done and clears when it leaves done', () => {
    db.prepare("INSERT INTO kanban_epics (id, state) VALUES ('e1', 'in_progress')").run();
    expect(epicCompletedAt('e1')).toBeNull();
    db.prepare("UPDATE kanban_epics SET state = 'done' WHERE id = 'e1'").run();
    expect(epicCompletedAt('e1')).not.toBeNull();
    db.prepare("UPDATE kanban_epics SET state = 'in_progress' WHERE id = 'e1'").run();
    expect(epicCompletedAt('e1')).toBeNull();
  });

  it('stamps ticket resolved_at on terminal status and clears on reopen', () => {
    db.prepare("INSERT INTO support_tickets (id, status) VALUES ('t1', 'new')").run();
    expect(ticketResolvedAt('t1')).toBeNull();
    db.prepare("UPDATE support_tickets SET status = 'converted' WHERE id = 't1'").run();
    expect(ticketResolvedAt('t1')).not.toBeNull();
    db.prepare("UPDATE support_tickets SET status = 'new' WHERE id = 't1'").run();
    expect(ticketResolvedAt('t1')).toBeNull();
  });
});
