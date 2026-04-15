import { db, stmts } from './db.js';
import crypto from 'crypto';

/**
 * List all notes for a project (metadata only, no content)
 */
export function listNotes(projectId) {
  return stmts.getNotes.all(projectId);
}

/**
 * Get a single note by ID
 */
export function getNote(noteId) {
  return stmts.getNote.get(noteId) || null;
}

/**
 * Create a new note
 */
export function createNote(projectId, { title, content = '' }) {
  const id = crypto.randomUUID();
  stmts.createNote.run(id, projectId, title, content);

  // Update FTS index
  try {
    db.prepare(
      'INSERT INTO notes_fts (rowid, title, content, project_id) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?, ?, ?)',
    ).run(id, title, content, projectId);
  } catch {
    /* FTS table might not exist yet */
  }

  return { id, project_id: projectId, title, content };
}

/**
 * Update an existing note
 */
export function updateNote(noteId, { title, content }) {
  const existing = stmts.getNote.get(noteId);
  if (!existing) throw new Error(`Note "${noteId}" not found`);

  const newTitle = title ?? existing.title;
  const newContent = content ?? existing.content;

  stmts.updateNote.run(newTitle, newContent, noteId);

  // Update FTS index
  try {
    const rowid = db.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId)?.rowid;
    if (rowid) {
      db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(rowid);
      db.prepare(
        'INSERT INTO notes_fts (rowid, title, content, project_id) VALUES (?, ?, ?, ?)',
      ).run(rowid, newTitle, newContent, existing.project_id);
    }
  } catch {
    /* FTS might not exist */
  }

  return { id: noteId, project_id: existing.project_id, title: newTitle, content: newContent };
}

/**
 * Delete a note
 */
export function deleteNote(noteId) {
  const existing = stmts.getNote.get(noteId);
  if (!existing) return false;

  // Remove from FTS first
  try {
    const rowid = db.prepare('SELECT rowid FROM notes WHERE id = ?').get(noteId)?.rowid;
    if (rowid) db.prepare('DELETE FROM notes_fts WHERE rowid = ?').run(rowid);
  } catch {
    /* skip */
  }

  stmts.deleteNote.run(noteId);
  return true;
}

/**
 * Full-text search across notes for a project
 */
export function searchNotes(projectId, query, limit = 20) {
  if (!query || !query.trim()) return listNotes(projectId);

  try {
    const results = db
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
      .all(query, projectId, limit);
    return results;
  } catch {
    // Fallback to LIKE search if FTS fails
    const results = db
      .prepare(
        `
      SELECT id, project_id, title, created_at, updated_at
      FROM notes
      WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(projectId, `%${query}%`, `%${query}%`, limit);
    return results;
  }
}
