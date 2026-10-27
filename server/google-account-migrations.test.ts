/**
 * Upgrades from single-account installs: Gmail importance rows and mirrored
 * reminder events move to each user's default Google account.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migrateGmailImportanceToMultiAccount } from './gmail-importance-schema.js';
import { REMINDERS_SCHEMA, migrateReminderCalendarAccounts } from './reminders-schema.js';

function legacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY);
    INSERT INTO users (id) VALUES ('u1'), ('u2');
    CREATE TABLE google_connections (id TEXT PRIMARY KEY, user_id TEXT, is_default INTEGER);
    INSERT INTO google_connections VALUES ('acct-1', 'u1', 1), ('acct-1b', 'u1', 0);
  `);
  return db;
}

describe('multi-account upgrade migrations', () => {
  it('moves Gmail importance settings and verdicts to the default account', () => {
    const db = legacyDb();
    db.exec(`
      CREATE TABLE gmail_importance_settings (
        user_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0,
        window_days INTEGER NOT NULL DEFAULT 7, auto_scan TEXT NOT NULL DEFAULT 'off',
        last_scan_at TEXT, last_scan_status TEXT NOT NULL DEFAULT 'idle', last_scan_error TEXT,
        last_scan_engine TEXT, last_scan_model TEXT, last_scan_failover TEXT,
        updated_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE gmail_importance_threads (
        user_id TEXT NOT NULL, thread_id TEXT NOT NULL, history_id TEXT,
        important INTEGER NOT NULL DEFAULT 0, score INTEGER NOT NULL DEFAULT 0, reason TEXT,
        subject TEXT, from_addr TEXT, snippet TEXT, last_message_at TEXT,
        scanned_at TEXT NOT NULL DEFAULT 'x', checked_at TEXT,
        PRIMARY KEY (user_id, thread_id));
      INSERT INTO gmail_importance_settings (user_id, enabled, auto_scan) VALUES
        ('u1', 1, 'hourly'), ('u2', 1, 'daily');
      INSERT INTO gmail_importance_threads (user_id, thread_id, important) VALUES
        ('u1', 't1', 1), ('u2', 't2', 1);
    `);

    migrateGmailImportanceToMultiAccount(db);
    migrateGmailImportanceToMultiAccount(db); // idempotent

    expect(
      db.prepare('SELECT user_id, account_id, auto_scan FROM gmail_importance_settings').all(),
    ).toEqual([{ user_id: 'u1', account_id: 'acct-1', auto_scan: 'hourly' }]);
    expect(
      db
        .prepare(
          'SELECT user_id, account_id, thread_id, dismissed_at_message FROM gmail_importance_threads',
        )
        .all(),
    ).toEqual([
      { user_id: 'u1', account_id: 'acct-1', thread_id: 't1', dismissed_at_message: null },
    ]);
  });

  it('stamps existing reminder events and cleanups with the default account', () => {
    const db = legacyDb();
    // The reminders tables as they were before the account columns.
    db.exec(
      REMINDERS_SCHEMA.replace('    calendar_account_id TEXT,\n', '').replace(
        '    account_id      TEXT,\n',
        '',
      ),
    );
    db.exec(`
      INSERT INTO reminders (id, user_id, title, remind_at, calendar_status, calendar_event_id,
                             created_at, updated_at)
        VALUES ('r1', 'u1', 'Linked', 'x', 'synced', 'ahr1', 'x', 'x'),
               ('r2', 'u1', 'Unlinked', 'x', 'none', NULL, 'x', 'x');
      INSERT INTO reminder_calendar_cleanups
        (id, user_id, reminder_id, calendar_id, event_id, next_attempt_at, created_at)
        VALUES ('c1', 'u1', 'gone', 'primary', 'ahr9', 'x', 'x');
    `);

    migrateReminderCalendarAccounts(db);
    migrateReminderCalendarAccounts(db);

    expect(db.prepare('SELECT id, calendar_account_id FROM reminders ORDER BY id').all()).toEqual([
      { id: 'r1', calendar_account_id: 'acct-1' },
      { id: 'r2', calendar_account_id: null },
    ]);
    expect(db.prepare('SELECT account_id FROM reminder_calendar_cleanups').get()).toEqual({
      account_id: 'acct-1',
    });
  });
});
