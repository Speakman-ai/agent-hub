import { db, stmts } from './db.js';
import crypto from 'crypto';
import type { NoteRow } from './types.js';

interface NoteInput {
  title: string;
  content?: string;
}

interface NoteUpdate {
  title?: string;
  content?: string;
}

interface NoteSearchResult {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  snippet?: string;
  rank?: number;
}

export function listNotes(projectId: string): NoteRow[] {
  return stmts!.getNotes.all(projectId) as NoteRow[];
}

export function getNote(noteId: string): NoteRow | null {
  return (stmts!.getNote.get(noteId) as NoteRow | undefined) || null;
}

export function createNote(projectId: string, { title, content = '' }: NoteInput): NoteRow {
  const id = crypto.randomUUID();
  stmts!.createNote.run(id, projectId, title, content);

  try {
    db!
      .prepare(
        'INSERT INTO notes_fts (rowid, title, content, project_id) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?, ?)',
      )
      .run(id, title, content, projectId);
  } catch {
    /* FTS table might not exist yet */
  }

  return { id, project_id: projectId, title, content, created_at: '', updated_at: '' };
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
    id: noteId,
    project_id: existing.project_id,
    title: newTitle,
    content: newContent,
    created_at: existing.created_at,
    updated_at: existing.updated_at,
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
): NoteSearchResult[] | NoteRow[] {
  if (!query || !query.trim()) return listNotes(projectId);

  try {
    const results = db!
      .prepare(
        `
      SELECT n.id, n.project_id, n.title, n.created_at, n.updated_at,
             snippet(notes_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
             rank
      FROM notes_fts fts
      JOIN notes n ON n.rowid = fts.rowid
      WHERE notes_fts MATCH ? AND n.project_id = ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(query, projectId, limit) as NoteSearchResult[];
    return results;
  } catch {
    const results = db!
      .prepare(
        `
      SELECT id, project_id, title, created_at, updated_at
      FROM notes
      WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(projectId, `%${query}%`, `%${query}%`, limit) as NoteSearchResult[];
    return results;
  }
}
