/**
 * Gmail importance scan: per-user settings plus the AI verdict for each inbox
 * thread. Kept apart from `gmail-importance-store.ts` so `orgs.ts` can apply
 * the DDL without importing the store (which depends on `orgs.ts`). Mirrors
 * `google-chat-drafts-schema.ts`.
 *
 * Verdicts are cached per thread with the Gmail `history_id` they were made
 * against. A later scan only sends threads to the model when that id changed
 * (new reply, label change), so automated scans stay cheap on the user's
 * subscription.
 *
 * Both tables are keyed by linked Google account (`account_id` is a
 * `google_connections.id`): each mailbox has its own settings, scan state, and
 * verdicts, and removing an account deletes only its rows
 * (`google-account-cleanup.ts`).
 */
import type Database from 'better-sqlite3';
const SETTINGS_COLUMNS = `
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id       TEXT NOT NULL,
    enabled          INTEGER NOT NULL DEFAULT 0,
    window_days      INTEGER NOT NULL DEFAULT 7 CHECK(window_days IN (1, 7, 30)),
    auto_scan        TEXT NOT NULL DEFAULT 'off'
                       CHECK(auto_scan IN ('off','hourly','every6h','daily')),
    last_scan_at     TEXT,
    last_scan_status TEXT NOT NULL DEFAULT 'idle'
                       CHECK(last_scan_status IN ('idle','running','ok','error')),
    last_scan_error  TEXT,
    last_scan_engine TEXT,
    last_scan_model  TEXT,
    last_scan_failover TEXT,
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (user_id, account_id)
`;

const THREAD_COLUMNS = `
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      TEXT NOT NULL,
    thread_id       TEXT NOT NULL,
    history_id      TEXT,
    important       INTEGER NOT NULL DEFAULT 0,
    score           INTEGER NOT NULL DEFAULT 0,
    reason          TEXT,
    subject         TEXT,
    from_addr       TEXT,
    snippet         TEXT,
    last_message_at TEXT,
    scanned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    -- Last time Gmail confirmed the thread is still in the inbox. Reconcile
    -- re-checks the least recently confirmed pins first, so every pin is
    -- revisited even when there are more than one scan can check.
    checked_at      TEXT,
    -- The user removed this pin. Holds the thread's last_message_at at that
    -- moment, so the thread stays out of the list until a newer message
    -- arrives. Rescans rewrite the verdict but never this column.
    dismissed_at_message TEXT,
    PRIMARY KEY (user_id, account_id, thread_id)
`;

export const GMAIL_IMPORTANCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gmail_importance_settings (${SETTINGS_COLUMNS});
  CREATE TABLE IF NOT EXISTS gmail_importance_threads (${THREAD_COLUMNS});
  CREATE INDEX IF NOT EXISTS idx_gmail_importance_threads_account_important
    ON gmail_importance_threads(user_id, account_id, important, last_message_at);
`;

/**
 * Rekey single-account tables (keyed by user only) to per-account rows. Each
 * user's existing settings and verdicts move to their default Google account;
 * rows for users with no linked account are dropped (nothing could be
 * scanned). No-op on a fresh DB or one already migrated. Run after the
 * google_connections migration.
 */
export function migrateGmailImportanceToMultiAccount(db: Database.Database): void {
  const cols = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  const settingsCols = cols('gmail_importance_settings');
  if (settingsCols.length === 0 || settingsCols.includes('account_id')) return;
  const threadCols = cols('gmail_importance_threads');
  const defaultAccount = `(SELECT id FROM google_connections g
                            WHERE g.user_id = old.user_id AND g.is_default = 1)`;
  db.transaction(() => {
    if (threadCols.length && !threadCols.includes('dismissed_at_message')) {
      db.exec('ALTER TABLE gmail_importance_threads ADD COLUMN dismissed_at_message TEXT');
    }
    if (threadCols.length && !threadCols.includes('checked_at')) {
      db.exec('ALTER TABLE gmail_importance_threads ADD COLUMN checked_at TEXT');
    }
    db.exec(`
      CREATE TABLE gmail_importance_settings_multi (${SETTINGS_COLUMNS});
      INSERT INTO gmail_importance_settings_multi
        (user_id, account_id, enabled, window_days, auto_scan, last_scan_at, last_scan_status,
         last_scan_error, last_scan_engine, last_scan_model, last_scan_failover, updated_at)
      SELECT user_id, ${defaultAccount}, enabled, window_days, auto_scan, last_scan_at,
             last_scan_status, last_scan_error, last_scan_engine, last_scan_model,
             last_scan_failover, updated_at
        FROM gmail_importance_settings old
       WHERE ${defaultAccount} IS NOT NULL;
      DROP TABLE gmail_importance_settings;
      ALTER TABLE gmail_importance_settings_multi RENAME TO gmail_importance_settings;
    `);
    if (threadCols.length) {
      db.exec(`
        CREATE TABLE gmail_importance_threads_multi (${THREAD_COLUMNS});
        INSERT INTO gmail_importance_threads_multi
          (user_id, account_id, thread_id, history_id, important, score, reason, subject,
           from_addr, snippet, last_message_at, scanned_at, checked_at, dismissed_at_message)
        SELECT user_id, ${defaultAccount}, thread_id, history_id, important, score, reason,
               subject, from_addr, snippet, last_message_at, scanned_at, checked_at,
               dismissed_at_message
          FROM gmail_importance_threads old
         WHERE ${defaultAccount} IS NOT NULL;
        DROP INDEX IF EXISTS idx_gmail_importance_threads_user_important;
        DROP TABLE gmail_importance_threads;
        ALTER TABLE gmail_importance_threads_multi RENAME TO gmail_importance_threads;
      `);
    }
  })();
}
