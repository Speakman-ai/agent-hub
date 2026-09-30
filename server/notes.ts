import { db, stmts } from './db.js';
import crypto from 'crypto';
import type { NoteRow } from './types.js';

interface NoteInput {
  title: string;
  content?: string;
  /** Creator. A note without an owner cannot be private. */
  ownerUserId?: string | null;
  shared?: boolean;
}

interface NoteUpdate {
  title?: string;
  content?: string;
}

interface NoteSearchResult {
  id: string;
  project_id: string;
  title: string;
  owner_user_id: string | null;
  shared: number;
  created_at: string;
  updated_at: string;
  snippet?: string;
  rank?: number;
}

/**
 * Who is looking at notes. `userId: null` is a caller with no per-user identity
 * (x-api-key break-glass, no-auth installs): it sees and manages everything,
 * matching how those callers see every project.
 */
export interface NoteViewer {
  userId: string | null;
}

/**
 * Private notes are owner-only, with no org-Owner override: they are a personal
 * capture surface, like todos. Unowned notes predate ownership and are shared.
 */
export function canViewNote(
  note: Pick<NoteRow, 'owner_user_id' | 'shared'>,
  viewer: NoteViewer,
): boolean {
  if (!viewer.userId) return true;
  if (note.shared || !note.owner_user_id) return true;
  return note.owner_user_id === viewer.userId;
}

/** Changing visibility or deleting is reserved to the owner. Unowned notes are open to anyone. */
export function canManageNote(note: Pick<NoteRow, 'owner_user_id'>, viewer: NoteViewer): boolean {
  if (!viewer.userId) return true;
  if (!note.owner_user_id) return true;
  return note.owner_user_id === viewer.userId;
}

const VISIBLE_SQL = '(n.shared = 1 OR n.owner_user_id IS NULL OR n.owner_user_id = ?)';

export function listNotes(projectId: string, viewer: NoteViewer = { userId: null }): NoteRow[] {
  const rows = stmts!.getNotes.all(projectId) as NoteRow[];
  return rows.filter((row) => canViewNote(row, viewer));
}

export function getNote(noteId: string): NoteRow | null {
  return (stmts!.getNote.get(noteId) as NoteRow | undefined) || null;
}

export function createNote(
  projectId: string,
  { title, content = '', ownerUserId = null, shared }: NoteInput,
): NoteRow {
  const id = crypto.randomUUID();
  // Signed-in users get private notes unless they ask to share; an ownerless
  // note has nobody to be private to, so it is always shared.
  const sharedFlag = !ownerUserId ? 1 : shared ? 1 : 0;
  stmts!.createNote.run(id, projectId, title, content, ownerUserId, sharedFlag);

  try {
    db!
      .prepare(
        'INSERT INTO notes_fts (rowid, title, content, project_id) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?, ?)',
      )
      .run(id, title, content, projectId);
  } catch {
    /* FTS table might not exist yet */
  }

  return (
    getNote(id) ?? {
      id,
      project_id: projectId,
      title,
      content,
      owner_user_id: ownerUserId,
      shared: sharedFlag,
      created_at: '',
      updated_at: '',
    }
  );
}

/**
 * Flip a note between shared and private. Making an unowned note private
 * assigns it to `claimantUserId`, since a private note needs an owner.
 */
export function setNoteShared(
  noteId: string,
  shared: boolean,
  claimantUserId: string | null,
): NoteRow {
  const existing = getNote(noteId);
  if (!existing) throw new Error(`Note "${noteId}" not found`);
  const owner = existing.owner_user_id ?? (shared ? null : claimantUserId);
  if (!shared && !owner) throw new Error('A private note needs an owner');
  stmts!.setNoteShared.run(shared ? 1 : 0, owner, noteId);
  return getNote(noteId)!;
}

export function updateNote(noteId: string, { title, content }: NoteUpdate): NoteRow {
  const existing = stmts!.getNote.get(noteId) as NoteRow | undefined;
  if (!existing) throw new Error(`Note "${noteId}" not found`);

  const newTitle = title ?? existing.title;
  const newContent = content ?? existing.content;

  stmts!.updateNote.run(newTitle, newContent, noteId);

  try {
    const row = db!.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId) as
      | { rowid: number }
      | undefined;
    if (row?.rowid) {
      db!.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.rowid);
      db!
        .prepare('INSERT INTO notes_fts (rowid, title, content, project_id) VALUES (?, ?, ?, ?)')
        .run(row.rowid, newTitle, newContent, existing.project_id);
    }
  } catch {
    /* FTS might not exist */
  }

  return {
    ...existing,
    title: newTitle,
    content: newContent,
  };
}

export function deleteNote(noteId: string): boolean {
  const existing = stmts!.getNote.get(noteId) as NoteRow | undefined;
  if (!existing) return false;

  try {
    const row = db!.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId) as
      | { rowid: number }
      | undefined;
    if (row?.rowid) db!.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(row.rowid);
  } catch {
    /* skip */
  }

  stmts!.deleteNote.run(noteId);
  return true;
}

export function searchNotes(
  projectId: string,
  query: string,
  limit: number = 20,
  viewer: NoteViewer = { userId: null },
): NoteSearchResult[] | NoteRow[] {
  if (!query || !query.trim()) return listNotes(projectId, viewer);
  const visibility = viewer.userId ? `AND ${VISIBLE_SQL}` : '';
  const visibilityArgs = viewer.userId ? [viewer.userId] : [];

  try {
    const results = db!
      .prepare(
        `
      SELECT n.id, n.project_id, n.title, n.owner_user_id, n.shared, n.created_at, n.updated_at,
             snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
             rank
      FROM notes_fts fts
      JOIN notes n ON n.rowid = fts.rowid
      WHERE notes_fts MATCH ? AND n.project_id = ? ${visibility}
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(query, projectId, ...visibilityArgs, limit) as NoteSearchResult[];
    return results;
  } catch {
    const results = db!
      .prepare(
        `
      SELECT n.id, n.project_id, n.title, n.owner_user_id, n.shared, n.created_at, n.updated_at
      FROM notes n
      WHERE n.project_id = ? AND (n.title LIKE ? OR n.content LIKE ?) ${visibility}
      ORDER BY n.updated_at DESC
      LIMIT ?
    `,
      )
      .all(projectId, `%${query}%`, `%${query}%`, ...visibilityArgs, limit) as NoteSearchResult[];
    return results;
  }
}
