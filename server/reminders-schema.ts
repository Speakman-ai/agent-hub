/**
 * reminders DDL (orgs.db, next to `users` so a deleted user's reminders
 * CASCADE away). Kept apart from `reminders-store.ts` so `orgs.ts` can apply it
 * without a circular import.
 *
 * `remind_at` and the other timestamps are ISO-8601 UTC strings written by the
 * store, so the due-reminder scan compares one format lexically.
 *
 * `session_id` / `agent_id` / `project_id` record where an agent-created
 * reminder came from. They are plain tags with no FK: a reminder must outlive
 * the session that set it.
 *
 * `calendar_*` columns track the optional Google Calendar mirror. A failed
 * update of a linked event keeps its id and is retried with backoff
 * (`calendar_attempts` / `calendar_retry_at`). `calendar_account_id` is the
 * linked Google account (`google_connections.id`) whose calendar holds the
 * event: new events go to the owner's default account, and every later patch
 * or delete targets the recorded account, so switching the default never
 * strands an event on the old calendar. Cleanup rows record it too.
 *
 * Every side effect owed after a commit is recorded in that commit and
 * cleared only once it is confirmed, so a crash or failed call is retried by
 * the scheduler instead of being lost:
 *  - notification delivery: `fired_at` set with `delivered_at` NULL until the
 *    inbox fan-out succeeds (`delivery_lease_until` keeps ticks from
 *    delivering the same reminder concurrently);
 *  - calendar insert: `pending`; calendar patch: `updating` (or `failed` with
 *    backoff); calendar delete: a `reminder_calendar_cleanups` row.
 *
 * `reminder_calendar_cleanups` is the durable queue of calendar events whose
 * reminder was deleted. A row is written in the same transaction as the
 * delete and removed only once Google confirms the event is gone, so a failed
 * or interrupted delete is retried instead of leaving an orphaned event.
 */
import type Database from 'better-sqlite3';

export const REMINDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS reminders (
    id                 TEXT PRIMARY KEY,
    user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title              TEXT NOT NULL,
    notes              TEXT NOT NULL DEFAULT '',
    remind_at          TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'fired', 'dismissed')),
    created_by         TEXT NOT NULL DEFAULT 'user' CHECK (created_by IN ('user', 'agent')),
    session_id         TEXT,
    agent_id           TEXT,
    project_id         TEXT,
    calendar_status    TEXT NOT NULL DEFAULT 'none'
                       CHECK (calendar_status IN ('none', 'pending', 'synced', 'updating', 'skipped', 'failed', 'removing', 'cancelled')),
    calendar_id        TEXT,
    calendar_account_id TEXT,
    calendar_event_id  TEXT,
    calendar_event_url TEXT,
    calendar_error     TEXT,
    calendar_attempts  INTEGER NOT NULL DEFAULT 0,
    calendar_retry_at  TEXT,
    calendar_generation INTEGER NOT NULL DEFAULT 0,
    fired_at           TEXT,
    delivered_at       TEXT,
    delivery_lease_until TEXT,
    dismissed_at       TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    revision           INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_user_remind_at ON reminders(user_id, remind_at);
  CREATE INDEX IF NOT EXISTS idx_reminders_due ON reminders(status, remind_at);
  -- Every write to a reminder bumps its revision, whatever code path made it,
  -- so clients can order a list response against live reminder_update events.
  -- The WHEN clause stops the trigger's own UPDATE from re-firing it.
  CREATE TRIGGER IF NOT EXISTS trg_reminders_revision
    AFTER UPDATE ON reminders
    FOR EACH ROW WHEN NEW.revision = OLD.revision
  BEGIN
    UPDATE reminders SET revision = OLD.revision + 1 WHERE id = NEW.id;
  END;

  CREATE TABLE IF NOT EXISTS reminder_calendar_cleanups (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reminder_id     TEXT NOT NULL,
    calendar_id     TEXT NOT NULL,
    account_id      TEXT,
    event_id        TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    next_attempt_at TEXT NOT NULL,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reminder_calendar_cleanups_due
    ON reminder_calendar_cleanups(next_attempt_at);
`;

/**
 * Add the account columns to installs that predate them. Existing events were
 * written to the owner's default account (the only one there was), so they
 * are stamped with it. Run after REMINDERS_SCHEMA and the google_connections
 * schema.
 */
export function migrateReminderCalendarAccounts(db: Database.Database): void {
  const has = (table: string, col: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
      (c) => c.name === col,
    );
  const defaultAccount = (alias: string) =>
    `(SELECT id FROM google_connections g WHERE g.user_id = ${alias}.user_id AND g.is_default = 1)`;
  db.transaction(() => {
    if (!has('reminders', 'calendar_account_id')) {
      db.exec('ALTER TABLE reminders ADD COLUMN calendar_account_id TEXT');
      db.exec(
        `UPDATE reminders SET calendar_account_id = ${defaultAccount('reminders')}
          WHERE calendar_event_id IS NOT NULL`,
      );
    }
    if (!has('reminder_calendar_cleanups', 'account_id')) {
      db.exec('ALTER TABLE reminder_calendar_cleanups ADD COLUMN account_id TEXT');
      db.exec(
        `UPDATE reminder_calendar_cleanups
            SET account_id = ${defaultAccount('reminder_calendar_cleanups')}`,
      );
    }
  })();
}
