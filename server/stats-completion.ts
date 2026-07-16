/**
 * Completion / resolution timestamps for project stats.
 *
 * The per-project Stats page needs accurate day/week/month buckets for three
 * lifecycle transitions that historically carried no dedicated timestamp:
 *
 *   - a kanban card entering a Done column   → `kanban_cards.completed_at`
 *   - an epic reaching `state = 'done'`      → `kanban_epics.completed_at`
 *   - a support ticket reaching a terminal   → `support_tickets.resolved_at`
 *     status (converted/closed/duplicate/wont_do)
 *
 * Before this, the only proxy was `updated_at`, which is re-stamped on any
 * later edit — so "how many completed last Tuesday" was unanswerable. Rather
 * than patch every write-path (board move endpoint, auto-close, auto-git
 * review moves, autonomous dispatch, the several support-ticket UPDATE sites),
 * the stamps are maintained by DB triggers. A trigger fires for *every* code
 * path that changes the driving column, so no call site can forget to stamp.
 *
 * Semantics (all three follow the same shape):
 *   - transition INTO the terminal state  → stamp `datetime('now')` unless a
 *     stamp already exists (COALESCE preserves the original completion time
 *     when moving e.g. Done → Done, or done → done between two done columns).
 *   - transition OUT of the terminal state → clear the stamp to NULL, so a
 *     reopened card/epic/ticket doesn't count as completed in that window.
 *
 * Card "Done" detection mirrors `isColumnDone` in kanban-blockers.ts: a
 * case-insensitive substring match on the column name (`%done%`), so renamed
 * columns like "Done ✅" / "Deployed / Done" still count.
 *
 * The SQL is exported so the migration (db.ts) and the regression test exercise
 * byte-identical statements.
 */

import type BetterSqlite3 from 'better-sqlite3';

/** Support-ticket statuses that count as "resolved" for stats. */
export const SUPPORT_TICKET_RESOLVED_STATUSES = [
  'converted',
  'closed',
  'duplicate',
  'wont_do',
] as const;

const RESOLVED_STATUS_SQL_LIST = SUPPORT_TICKET_RESOLVED_STATUSES.map((s) => `'${s}'`).join(', ');

// ─── kanban_cards.completed_at ───────────────────────────────────────────────

export const KANBAN_CARD_COMPLETED_AT_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS kanban_cards_set_completed_at_on_move
  AFTER UPDATE OF column_id ON kanban_cards
  FOR EACH ROW
  BEGIN
    UPDATE kanban_cards
       SET completed_at = CASE
         WHEN EXISTS (
           SELECT 1 FROM kanban_columns
            WHERE id = NEW.column_id AND lower(name) LIKE '%done%'
         )
         THEN COALESCE(NEW.completed_at, datetime('now'))
         ELSE NULL
       END
     WHERE id = NEW.id;
  END;
`;

export const KANBAN_CARD_COMPLETED_AT_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS kanban_cards_set_completed_at_on_insert
  AFTER INSERT ON kanban_cards
  FOR EACH ROW WHEN NEW.completed_at IS NULL AND EXISTS (
    SELECT 1 FROM kanban_columns
     WHERE id = NEW.column_id AND lower(name) LIKE '%done%'
  )
  BEGIN
    UPDATE kanban_cards SET completed_at = datetime('now') WHERE id = NEW.id;
  END;
`;

// ─── kanban_epics.completed_at ───────────────────────────────────────────────

export const KANBAN_EPIC_COMPLETED_AT_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS kanban_epics_set_completed_at_on_state
  AFTER UPDATE OF state ON kanban_epics
  FOR EACH ROW
  BEGIN
    UPDATE kanban_epics
       SET completed_at = CASE
         WHEN NEW.state = 'done' THEN COALESCE(NEW.completed_at, datetime('now'))
         ELSE NULL
       END
     WHERE id = NEW.id;
  END;
`;

export const KANBAN_EPIC_COMPLETED_AT_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS kanban_epics_set_completed_at_on_insert
  AFTER INSERT ON kanban_epics
  FOR EACH ROW WHEN NEW.completed_at IS NULL AND NEW.state = 'done'
  BEGIN
    UPDATE kanban_epics SET completed_at = datetime('now') WHERE id = NEW.id;
  END;
`;

// ─── support_tickets.resolved_at ─────────────────────────────────────────────

export const SUPPORT_TICKET_RESOLVED_AT_UPDATE_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS support_tickets_set_resolved_at_on_status
  AFTER UPDATE OF status ON support_tickets
  FOR EACH ROW
  BEGIN
    UPDATE support_tickets
       SET resolved_at = CASE
         WHEN NEW.status IN (${RESOLVED_STATUS_SQL_LIST})
           THEN COALESCE(NEW.resolved_at, datetime('now'))
         ELSE NULL
       END
     WHERE id = NEW.id;
  END;
`;

export const SUPPORT_TICKET_RESOLVED_AT_INSERT_TRIGGER_SQL = `
  CREATE TRIGGER IF NOT EXISTS support_tickets_set_resolved_at_on_insert
  AFTER INSERT ON support_tickets
  FOR EACH ROW WHEN NEW.resolved_at IS NULL AND NEW.status IN (${RESOLVED_STATUS_SQL_LIST})
  BEGIN
    UPDATE support_tickets SET resolved_at = datetime('now') WHERE id = NEW.id;
  END;
`;

// ─── One-time backfill (approximate: uses updated_at for existing rows) ───────

/**
 * Marker recorded in `stats_completion_migrations` once the legacy backfill has
 * run for a given DB. The backfill is gated on this so it executes exactly once
 * per database — NOT on every startup. Without the gate, a terminal row whose
 * stamp was intentionally cleared (a reopened-then-reclosed card with the
 * trigger having nulled it, or a manually-inserted terminal row) would be
 * re-stamped from `updated_at` on the next boot, silently overriding the live
 * trigger semantics.
 */
export const STATS_BACKFILL_MARKER = 'completion_timestamps_backfill_v1';

export const KANBAN_CARD_COMPLETED_AT_BACKFILL_SQL = `
  UPDATE kanban_cards
     SET completed_at = updated_at
   WHERE completed_at IS NULL
     AND column_id IN (SELECT id FROM kanban_columns WHERE lower(name) LIKE '%done%');
`;

export const KANBAN_EPIC_COMPLETED_AT_BACKFILL_SQL = `
  UPDATE kanban_epics
     SET completed_at = updated_at
   WHERE completed_at IS NULL AND state = 'done';
`;

export const SUPPORT_TICKET_RESOLVED_AT_BACKFILL_SQL = `
  UPDATE support_tickets
     SET resolved_at = updated_at
   WHERE resolved_at IS NULL AND status IN (${RESOLVED_STATUS_SQL_LIST});
`;

/** True only for SQLite's "duplicate column name" ALTER error. */
function isDuplicateColumnError(err: unknown): boolean {
  return err instanceof Error && /duplicate column name/i.test(err.message);
}

/**
 * Add a nullable completion column, tolerating only the "already exists" case.
 *
 * On a fresh DB the bootstrap schema already declares these columns, so the
 * ALTER is expected to fail with a duplicate-column error — that one we ignore.
 * ANY other failure (missing table, disk/IO, corruption) is a real migration
 * problem and is rethrown so startup fails loudly rather than silently running
 * stats without the expected columns/triggers.
 */
function addCompletionColumn(db: BetterSqlite3.Database, sql: string): void {
  try {
    db.exec(sql);
  } catch (err) {
    if (isDuplicateColumnError(err)) return;
    throw err;
  }
}

/**
 * Install the completion-timestamp columns, triggers, indexes, and the one-time
 * legacy backfill.
 *
 * Idempotent and safe on every init: ALTERs tolerate only duplicate-column,
 * triggers/indexes use `IF NOT EXISTS`, and the backfill is gated behind a
 * marker row so it runs exactly once per DB (see STATS_BACKFILL_MARKER).
 *
 * Assumes kanban_cards / kanban_epics / support_tickets already exist (called
 * after the bootstrap schema `db.exec`).
 */
export function installStatsCompletionTimestamps(db: BetterSqlite3.Database): void {
  addCompletionColumn(db, 'ALTER TABLE kanban_cards ADD COLUMN completed_at TEXT');
  addCompletionColumn(db, 'ALTER TABLE kanban_epics ADD COLUMN completed_at TEXT');
  addCompletionColumn(db, 'ALTER TABLE support_tickets ADD COLUMN resolved_at TEXT');

  db.exec(KANBAN_CARD_COMPLETED_AT_UPDATE_TRIGGER_SQL);
  db.exec(KANBAN_CARD_COMPLETED_AT_INSERT_TRIGGER_SQL);
  db.exec(KANBAN_EPIC_COMPLETED_AT_UPDATE_TRIGGER_SQL);
  db.exec(KANBAN_EPIC_COMPLETED_AT_INSERT_TRIGGER_SQL);
  db.exec(SUPPORT_TICKET_RESOLVED_AT_UPDATE_TRIGGER_SQL);
  db.exec(SUPPORT_TICKET_RESOLVED_AT_INSERT_TRIGGER_SQL);

  // Composite indexes matching the stats endpoint's project-scoped range scans
  // (server/project-stats.ts): each metric filters by the project key + a
  // timestamp window, and model usage joins messages by session_id + created_at.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_cards_board_created_at ON kanban_cards(board_id, created_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_cards_board_completed_at ON kanban_cards(board_id, completed_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_kanban_epics_board_completed_at ON kanban_epics(board_id, completed_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_support_tickets_project_resolved_at ON support_tickets(project_id, resolved_at)',
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_pull_requests_project_status_merged_at ON pull_requests(project_id, status, merged_at)',
  );
  // Backs the model-usage join+filter: sessions (agent_id) → messages by
  // session_id with a created_at window. Avoids a full messages scan per load.
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_messages_session_created_at ON messages(session_id, created_at)',
  );

  // Gate the legacy backfill on a marker so it runs exactly once per DB, never
  // re-stamping rows whose completion timestamp has since been (correctly)
  // cleared by the triggers or by hand.
  db.exec(`
    CREATE TABLE IF NOT EXISTS stats_completion_migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const alreadyBackfilled = db
    .prepare('SELECT 1 FROM stats_completion_migrations WHERE name = ?')
    .get(STATS_BACKFILL_MARKER);
  if (!alreadyBackfilled) {
    const runBackfill = db.transaction(() => {
      db.exec(KANBAN_CARD_COMPLETED_AT_BACKFILL_SQL);
      db.exec(KANBAN_EPIC_COMPLETED_AT_BACKFILL_SQL);
      db.exec(SUPPORT_TICKET_RESOLVED_AT_BACKFILL_SQL);
      db.prepare('INSERT INTO stats_completion_migrations (name) VALUES (?)').run(
        STATS_BACKFILL_MARKER,
      );
    });
    runBackfill();
  }
}
