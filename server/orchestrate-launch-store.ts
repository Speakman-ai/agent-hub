/**
 * Server copy of an Orchestrate chat's launch settings (Default build and
 * Auto start) and of the forward cards whose auto start the user cancelled.
 *
 * The clients keep their own copy for instant UI, but the server needs one
 * too: a turn that runs while nobody has the chat open (a poller run, a
 * background-shell wake) still posts forward cards, and only the server is
 * there to start them.
 */
import type { Database } from 'better-sqlite3';
import {
  parseSessionForwardMode,
  type SessionForwardMode,
} from '../shared/utils/extractForwardBlocks.js';

export interface OrchestrateLaunchSettingsRow {
  mode: SessionForwardMode;
  autoStart: boolean;
  /** False when nobody has saved settings for this chat yet. */
  configured: boolean;
  /**
   * Bumped on every save. Clients apply a server value only when its revision
   * is newer than any they have seen, so responses arriving out of order
   * cannot roll a setting back. 0 before the first save.
   */
  revision: number;
}

export interface LaunchedForward {
  dispatchKey: string;
  sessionId: string;
  agentId: string;
  name: string;
  mode: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS orchestrate_launch_settings (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT 'manual',
  auto_start INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0,
  auto_start_after_message INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orchestrate_auto_start_cancels (
  dispatch_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_orchestrate_auto_start_cancels_created
  ON orchestrate_auto_start_cancels(created_at);
CREATE TABLE IF NOT EXISTS orchestrate_auto_start_pending (
  dispatch_key TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  card_json TEXT NOT NULL,
  deadline_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestrate_auto_start_pending_session
  ON orchestrate_auto_start_pending(session_id);
`;

function normalizeMode(value: unknown): SessionForwardMode {
  const mode = parseSessionForwardMode(value);
  return mode === 'consult' ? 'manual' : mode;
}

export class OrchestrateLaunchStore {
  private readonly lastMessageSql: string;

  constructor(private readonly db: Database) {
    db.exec(SCHEMA);
    try {
      db.prepare('SELECT auto_start_after_message FROM orchestrate_launch_settings LIMIT 1').get();
    } catch {
      db.exec(
        'ALTER TABLE orchestrate_launch_settings ADD COLUMN auto_start_after_message INTEGER',
      );
    }
    const hasTable = (name: string) =>
      Boolean(
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
      );
    // A durable insertion sequence for messages. AUTOINCREMENT never reuses a
    // value, even after the newest rows are deleted, and its high-water mark
    // in sqlite_sequence never goes down, so "inserted after the boundary" is
    // exact (unlike a whole-second timestamp or a reusable rowid). Messages
    // from before this table existed have no entry and count as before.
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestrate_message_order (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE
      );
    `);
    if (hasTable('messages')) {
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_orchestrate_message_order_ai
        AFTER INSERT ON messages
        BEGIN
          INSERT OR IGNORE INTO orchestrate_message_order (message_id) VALUES (NEW.id);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_orchestrate_message_order_ad
        AFTER DELETE ON messages
        BEGIN
          DELETE FROM orchestrate_message_order WHERE message_id = OLD.id;
        END;
      `);
    }
    this.lastMessageSql = `(SELECT COALESCE(
      (SELECT seq FROM sqlite_sequence WHERE name = 'orchestrate_message_order'), 0))`;
    if (hasTable('sessions')) {
      // Leaving Orchestrate ends the chat's countdowns, and coming back starts
      // the Auto start clock afresh, so a card from before is never started.
      // Triggers cover every path that changes a session's mode.
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS trg_orchestrate_launch_leave
        AFTER UPDATE OF session_mode ON sessions
        WHEN OLD.session_mode = 'orchestrate' AND NEW.session_mode IS NOT 'orchestrate'
        BEGIN
          DELETE FROM orchestrate_auto_start_pending WHERE session_id = NEW.id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_orchestrate_launch_enter
        AFTER UPDATE OF session_mode ON sessions
        WHEN NEW.session_mode = 'orchestrate' AND OLD.session_mode IS NOT 'orchestrate'
        BEGIN
          UPDATE orchestrate_launch_settings
             SET auto_start_after_message = ${this.lastMessageSql}
           WHERE session_id = NEW.id AND auto_start = 1;
        END;
      `);
    }
  }

  /**
   * The message sequence high-water mark when Auto start was last switched on (or the
   * chat last entered Orchestrate with it on), or null while it is off. Only
   * cards in messages inserted after it are ever started automatically, so a
   * card from before (posted while it was off, or before the server ran Auto
   * start, perhaps cancelled only in a browser then) never is.
   */
  activationBoundary(sessionId: string): number | null {
    const row = this.db
      .prepare(
        'SELECT auto_start_after_message FROM orchestrate_launch_settings WHERE session_id = ? AND auto_start = 1',
      )
      .get(sessionId) as { auto_start_after_message: number | null } | undefined;
    return row?.auto_start_after_message ?? null;
  }

  /** A message's place in the insertion sequence, or null when it has none. */
  messageOrder(messageId: string): number | null {
    const row = this.db
      .prepare('SELECT seq FROM orchestrate_message_order WHERE message_id = ?')
      .get(messageId) as { seq: number } | undefined;
    return row?.seq ?? null;
  }

  getSettings(sessionId: string): OrchestrateLaunchSettingsRow {
    const row = this.db
      .prepare(
        'SELECT mode, auto_start, revision FROM orchestrate_launch_settings WHERE session_id = ?',
      )
      .get(sessionId) as { mode: string; auto_start: number; revision: number } | undefined;
    if (!row) return { mode: 'manual', autoStart: false, configured: false, revision: 0 };
    return {
      mode: normalizeMode(row.mode),
      autoStart: row.auto_start === 1,
      configured: true,
      revision: row.revision,
    };
  }

  /** Save a settings change. Every save bumps the chat's revision. */
  setSettings(
    sessionId: string,
    patch: { mode?: SessionForwardMode; autoStart?: boolean },
  ): OrchestrateLaunchSettingsRow {
    const current = this.getSettings(sessionId);
    const mode = normalizeMode(patch.mode ?? current.mode);
    const autoStart = patch.autoStart ?? current.autoStart;
    const saved = this.db
      .prepare(
        `INSERT INTO orchestrate_launch_settings
           (session_id, mode, auto_start, revision, auto_start_after_message, updated_at)
         VALUES (?, ?, ?, 1, CASE WHEN ? THEN ${this.lastMessageSql} END, datetime('now'))
         ON CONFLICT(session_id) DO UPDATE SET
           mode = excluded.mode,
           auto_start = excluded.auto_start,
           revision = orchestrate_launch_settings.revision + 1,
           auto_start_after_message = CASE
             WHEN excluded.auto_start = 0 THEN NULL
             WHEN orchestrate_launch_settings.auto_start = 1
               THEN COALESCE(
                 orchestrate_launch_settings.auto_start_after_message,
                 ${this.lastMessageSql}
               )
             ELSE ${this.lastMessageSql}
           END,
           updated_at = excluded.updated_at
         RETURNING revision`,
      )
      .get(sessionId, mode, autoStart ? 1 : 0, autoStart ? 1 : 0) as { revision: number };
    return { mode, autoStart, configured: true, revision: saved.revision };
  }

  /** Sessions with Auto start on, for re-arming cards after a restart. */
  listAutoStartSessionIds(): string[] {
    return (
      this.db
        .prepare('SELECT session_id FROM orchestrate_launch_settings WHERE auto_start = 1')
        .all() as Array<{ session_id: string }>
    ).map((row) => row.session_id);
  }

  cancel(dispatchKey: string): void {
    // Kept for good: a card's cancel must hold for as long as the card can be
    // seen, the same as the permanent record of a started card.
    this.db
      .prepare('INSERT OR IGNORE INTO orchestrate_auto_start_cancels (dispatch_key) VALUES (?)')
      .run(dispatchKey);
  }

  isCancelled(dispatchKey: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM orchestrate_auto_start_cancels WHERE dispatch_key = ?')
        .get(dispatchKey),
    );
  }

  /**
   * Running server countdowns, saved so a restart resumes them at their
   * original deadline instead of losing them.
   */
  savePending(dispatchKey: string, sessionId: string, card: unknown, deadlineMs: number): void {
    this.db
      .prepare(
        `INSERT INTO orchestrate_auto_start_pending (dispatch_key, session_id, card_json, deadline_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(dispatch_key) DO UPDATE SET
           card_json = excluded.card_json, deadline_ms = excluded.deadline_ms`,
      )
      .run(dispatchKey, sessionId, JSON.stringify(card), deadlineMs);
  }

  hasPending(dispatchKey: string): boolean {
    return Boolean(
      this.db
        .prepare('SELECT 1 FROM orchestrate_auto_start_pending WHERE dispatch_key = ?')
        .get(dispatchKey),
    );
  }

  deletePending(dispatchKey: string): void {
    this.db
      .prepare('DELETE FROM orchestrate_auto_start_pending WHERE dispatch_key = ?')
      .run(dispatchKey);
  }

  deletePendingForSession(sessionId: string): void {
    this.db
      .prepare('DELETE FROM orchestrate_auto_start_pending WHERE session_id = ?')
      .run(sessionId);
  }

  listPending(): Array<{
    dispatchKey: string;
    sessionId: string;
    card: unknown;
    deadlineMs: number;
  }> {
    const rows = this.db
      .prepare(
        'SELECT dispatch_key, session_id, card_json, deadline_ms FROM orchestrate_auto_start_pending',
      )
      .all() as Array<{
      dispatch_key: string;
      session_id: string;
      card_json: string;
      deadline_ms: number;
    }>;
    const out: Array<{
      dispatchKey: string;
      sessionId: string;
      card: unknown;
      deadlineMs: number;
    }> = [];
    for (const row of rows) {
      try {
        out.push({
          dispatchKey: row.dispatch_key,
          sessionId: row.session_id,
          card: JSON.parse(row.card_json),
          deadlineMs: row.deadline_ms,
        });
      } catch {
        this.deletePending(row.dispatch_key);
      }
    }
    return out;
  }

  /** Dispatch keys of this chat's cards whose auto start was cancelled. */
  listCancelled(sessionId: string): string[] {
    const prefix = `session-forward:${sessionId}:`;
    return (
      this.db
        .prepare(
          'SELECT dispatch_key FROM orchestrate_auto_start_cancels WHERE substr(dispatch_key, 1, length(?)) = ?',
        )
        .all(prefix, prefix) as Array<{ dispatch_key: string }>
    ).map((row) => row.dispatch_key);
  }

  /** Cards in this chat that already started a session, from the dispatch keys. */
  listLaunched(sessionId: string, ownerUserId: string | null): LaunchedForward[] {
    if (!ownerUserId) return [];
    const prefix = `session-forward:${sessionId}:`;
    const rows = this.db
      .prepare(
        `SELECT idem_key, session_id, agent_id, name, mode FROM session_dispatch_keys
          WHERE owner_user_id = ? AND session_id IS NOT NULL
            AND substr(idem_key, 1, length(?)) = ?`,
      )
      .all(ownerUserId, prefix, prefix) as Array<{
      idem_key: string;
      session_id: string;
      agent_id: string | null;
      name: string | null;
      mode: string | null;
    }>;
    return rows.map((row) => ({
      dispatchKey: row.idem_key,
      sessionId: row.session_id,
      agentId: row.agent_id ?? '',
      name: row.name ?? '',
      mode: row.mode ?? 'manual',
    }));
  }
}
