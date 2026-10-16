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
 */
export const GMAIL_IMPORTANCE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS gmail_importance_settings (
    user_id          TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS gmail_importance_threads (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
    PRIMARY KEY (user_id, thread_id)
  );
  CREATE INDEX IF NOT EXISTS idx_gmail_importance_threads_user_important
    ON gmail_importance_threads(user_id, important, last_message_at);
`;
