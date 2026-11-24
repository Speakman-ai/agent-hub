/**
 * Schema for per-user session folders. Kept free of `db.js` imports so
 * `initDb` can call it without an import cycle.
 *
 * Folders belong to one (user, agent) pair. Filing is per user too: the
 * assignment row is keyed by (user_id, session_id), so two users who can both
 * see a session file it independently.
 */
import type BetterSqlite3 from 'better-sqlite3';

export const SESSION_FOLDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS session_folders (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_session_folders_user_agent
    ON session_folders(user_id, agent_id);
  CREATE TABLE IF NOT EXISTS session_folder_assignments (
    user_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    folder_id TEXT NOT NULL REFERENCES session_folders(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, session_id)
  );
  CREATE INDEX IF NOT EXISTS idx_session_folder_assignments_folder
    ON session_folder_assignments(folder_id);
`;

export function ensureSessionFoldersSchema(db: BetterSqlite3.Database): void {
  db.exec(SESSION_FOLDERS_SCHEMA);
}
