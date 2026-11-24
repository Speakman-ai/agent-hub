/**
 * Per-user session folders inside one agent's sidebar list. Schema lives in
 * `migrations/session-folders.ts`. Every read and write is scoped to a user
 * key, so one user's folders and filing never leak into another's sidebar.
 */
import { randomUUID } from 'crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { getDb } from './db.js';

export const SESSION_FOLDER_NAME_MAX = 80;

export interface SessionFolderRow {
  id: string;
  user_id: string;
  agent_id: string;
  name: string;
  position: number;
  created_at: string;
}

export interface SessionFolder {
  id: string;
  agentId: string;
  name: string;
  position: number;
  createdAt: string;
}

export interface SessionFolderListing {
  folders: SessionFolder[];
  /** sessionId → folderId for the caller's filed sessions of this agent. */
  assignments: Record<string, string>;
}

function toFolder(row: SessionFolderRow): SessionFolder {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    position: row.position,
    createdAt: row.created_at,
  };
}

export function listSessionFolders(
  userId: string,
  agentId: string,
  db: BetterSqlite3.Database = getDb(),
): SessionFolderListing {
  const rows = db
    .prepare(
      'SELECT * FROM session_folders WHERE user_id = ? AND agent_id = ? ORDER BY position ASC, created_at ASC',
    )
    .all(userId, agentId) as SessionFolderRow[];
  const links = db
    .prepare(
      `SELECT a.session_id, a.folder_id FROM session_folder_assignments a
         JOIN session_folders f ON f.id = a.folder_id
        WHERE a.user_id = ? AND f.agent_id = ?`,
    )
    .all(userId, agentId) as Array<{ session_id: string; folder_id: string }>;
  const assignments: Record<string, string> = {};
  for (const l of links) assignments[l.session_id] = l.folder_id;
  return { folders: rows.map(toFolder), assignments };
}

export function getSessionFolder(
  userId: string,
  folderId: string,
  db: BetterSqlite3.Database = getDb(),
): SessionFolder | null {
  const row = db
    .prepare('SELECT * FROM session_folders WHERE id = ? AND user_id = ?')
    .get(folderId, userId) as SessionFolderRow | undefined;
  return row ? toFolder(row) : null;
}

export function createSessionFolder(
  userId: string,
  agentId: string,
  name: string,
  db: BetterSqlite3.Database = getDb(),
): SessionFolder {
  const id = randomUUID();
  const next = db
    .prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM session_folders WHERE user_id = ? AND agent_id = ?',
    )
    .get(userId, agentId) as { p: number };
  db.prepare(
    'INSERT INTO session_folders (id, user_id, agent_id, name, position) VALUES (?, ?, ?, ?, ?)',
  ).run(id, userId, agentId, name, next.p);
  return getSessionFolder(userId, id, db)!;
}

export function renameSessionFolder(
  userId: string,
  folderId: string,
  name: string,
  db: BetterSqlite3.Database = getDb(),
): SessionFolder | null {
  db.prepare('UPDATE session_folders SET name = ? WHERE id = ? AND user_id = ?').run(
    name,
    folderId,
    userId,
  );
  return getSessionFolder(userId, folderId, db);
}

/** Deletes the folder. Its sessions are not touched; they return to the unfiled list. */
export function deleteSessionFolder(
  userId: string,
  folderId: string,
  db: BetterSqlite3.Database = getDb(),
): boolean {
  return db.transaction(() => {
    db.prepare('DELETE FROM session_folder_assignments WHERE folder_id = ? AND user_id = ?').run(
      folderId,
      userId,
    );
    return (
      db.prepare('DELETE FROM session_folders WHERE id = ? AND user_id = ?').run(folderId, userId)
        .changes > 0
    );
  })();
}

/** Files the session into `folderId`, or unfiles it when `folderId` is null. */
export function setSessionFolder(
  userId: string,
  sessionId: string,
  folderId: string | null,
  db: BetterSqlite3.Database = getDb(),
): void {
  if (folderId === null) {
    db.prepare('DELETE FROM session_folder_assignments WHERE user_id = ? AND session_id = ?').run(
      userId,
      sessionId,
    );
    return;
  }
  db.prepare(
    `INSERT INTO session_folder_assignments (user_id, session_id, folder_id) VALUES (?, ?, ?)
     ON CONFLICT(user_id, session_id) DO UPDATE SET folder_id = excluded.folder_id`,
  ).run(userId, sessionId, folderId);
}
