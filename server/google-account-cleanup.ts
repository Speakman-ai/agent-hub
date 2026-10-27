/**
 * Stop the background work owned by a Google account that was just removed
 * (disconnected, revoked at Google, or replaced by an exclusive connect).
 *
 * Every per-account job keys its rows by the account id, so removing one
 * account touches only that account's rows:
 *  - Gmail importance: its settings row (which drives auto-scan) and cached
 *    verdicts are deleted.
 *  - Reminder calendar mirror: events on that account's calendar can no longer
 *    be reached, so linked reminders stop syncing (`skipped`, with the reason)
 *    and queued deletions on that calendar are dropped.
 *  - Google Chat: when the removed identity was the user's Chat account, the
 *    push state (subscription row, unread counts) is cleared. The binding row
 *    is kept, so relinking the same Google account restores Chat.
 *
 * Runs inside the caller's transaction on the orgs DB. The Chat state lives
 * in the main DB and is cleared best effort.
 */
import type Database from 'better-sqlite3';
import { clearChatEventState } from './google-chat-events-store.js';

export interface RemovedGoogleAccount {
  id: string;
  user_id: string;
  google_sub: string;
  google_email: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

export function releaseGoogleAccountWork(
  db: Database.Database,
  account: RemovedGoogleAccount,
): { chatCleared: boolean } {
  const { id, user_id: userId } = account;
  if (tableExists(db, 'gmail_importance_settings')) {
    db.prepare('DELETE FROM gmail_importance_threads WHERE user_id = ? AND account_id = ?').run(
      userId,
      id,
    );
    db.prepare('DELETE FROM gmail_importance_settings WHERE user_id = ? AND account_id = ?').run(
      userId,
      id,
    );
  }
  if (tableExists(db, 'reminders') && hasColumn(db, 'reminders', 'calendar_account_id')) {
    db.prepare(
      `UPDATE reminders SET calendar_status = 'skipped', calendar_event_id = NULL,
         calendar_event_url = NULL, calendar_error = ?, calendar_attempts = 0,
         calendar_retry_at = NULL
       WHERE user_id = ? AND calendar_account_id = ?
         AND calendar_status IN ('pending', 'synced', 'updating', 'failed', 'removing')`,
    ).run(`Google account ${account.google_email} was disconnected`, userId, id);
    db.prepare('DELETE FROM reminder_calendar_cleanups WHERE user_id = ? AND account_id = ?').run(
      userId,
      id,
    );
  }

  let chatCleared = false;
  const binding = db
    .prepare('SELECT google_sub FROM google_chat_accounts WHERE user_id = ?')
    .get(userId) as { google_sub: string } | undefined;
  if (binding?.google_sub === account.google_sub) {
    try {
      clearChatEventState(userId);
      chatCleared = true;
    } catch (err) {
      // The maintenance loop clears it on its next pass (access is gone).
      console.warn(
        `[google-accounts] Could not clear Chat push state for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
  return { chatCleared };
}
