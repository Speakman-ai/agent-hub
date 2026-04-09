import { db, stmts } from './db.js';
import crypto from 'crypto';

// Valid categories
const CATEGORIES = ['general', 'api-docs', 'architecture', 'conventions', 'test-patterns', 'troubleshooting', 'onboarding'];

function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * List all wiki pages for a project (metadata only, no content)
 */
export function listPages(projectId) {
  return stmts.getWikiPages.all(projectId);
}

/**
 * Get a single wiki page by slug
 */
export function getPage(projectId, slug) {
  return stmts.getWikiPage.get(projectId, slug) || null;
}

/**
 * Create a new wiki page
 */
export function createPage(projectId, { title, content = '', category = 'general', updatedBy = 'user' }) {
  const id = crypto.randomUUID();
  const slug = slugify(title);

  // Check for duplicate slug
  const existing = stmts.getWikiPage.get(projectId, slug);
  if (existing) {
    throw new Error(`A page with slug "${slug}" already exists in this project`);
  }

  stmts.createWikiPage.run(id, projectId, title, slug, content, category, updatedBy);

  // Update FTS index
  try {
    db.prepare('INSERT INTO wiki_pages_fts (rowid, title, content, slug, project_id) VALUES ((SELECT rowid FROM wiki_pages WHERE id = ?), ?, ?, ?, ?)').run(id, title, content, slug, projectId);
  } catch { /* FTS table might not exist yet */ }

  return { id, slug, title, content, category, updatedBy };
}

/**
 * Update an existing wiki page
 */
export function updatePage(projectId, slug, { title, content, category, updatedBy = 'user' }) {
  const existing = stmts.getWikiPage.get(projectId, slug);
  if (!existing) throw new Error(`Page "${slug}" not found`);

  const newTitle = title ?? existing.title;
  const newContent = content ?? existing.content;
  const newCategory = category ?? existing.category;
  const newSlug = title ? slugify(title) : slug;

  // If slug is changing, check for conflicts
  if (newSlug !== slug) {
    const conflict = stmts.getWikiPage.get(projectId, newSlug);
    if (conflict) throw new Error(`A page with slug "${newSlug}" already exists`);
  }

  // Update the main table
  if (newSlug !== slug) {
    // Need to delete + recreate since slug is part of the unique constraint
    db.prepare('DELETE FROM wiki_pages WHERE project_id = ? AND slug = ?').run(projectId, slug);
    stmts.createWikiPage.run(existing.id, projectId, newTitle, newSlug, newContent, newCategory, updatedBy);
  } else {
    stmts.updateWikiPage.run(newTitle, newContent, newCategory, updatedBy, projectId, slug);
  }

  // Update FTS index
  try {
    const rowid = db.prepare('SELECT rowid FROM wiki_pages WHERE id = ?').get(existing.id)?.rowid;
    if (rowid) {
      db.prepare('DELETE FROM wiki_pages_fts WHERE rowid = ?').run(rowid);
      db.prepare('INSERT INTO wiki_pages_fts (rowid, title, content, slug, project_id) VALUES (?, ?, ?, ?, ?)').run(rowid, newTitle, newContent, newSlug, projectId);
    }
  } catch { /* FTS might not exist */ }

  return { id: existing.id, slug: newSlug, title: newTitle, content: newContent, category: newCategory, updatedBy };
}

/**
 * Delete a wiki page
 */
export function deletePage(projectId, slug) {
  const existing = stmts.getWikiPage.get(projectId, slug);
  if (!existing) return false;

  // Remove from FTS first
  try {
    const rowid = db.prepare('SELECT rowid FROM wiki_pages WHERE id = ?').get(existing.id)?.rowid;
    if (rowid) db.prepare('DELETE FROM wiki_pages_fts WHERE rowid = ?').run(rowid);
  } catch { /* skip */ }

  stmts.deleteWikiPage.run(projectId, slug);
  return true;
}

/**
 * Full-text search across wiki pages for a project
 */
export function searchPages(projectId, query, limit = 10) {
  if (!query || !query.trim()) return listPages(projectId);

  try {
    // FTS5 search with ranking
    const results = db.prepare(`
      SELECT wp.id, wp.project_id, wp.title, wp.slug, wp.category, wp.updated_by,
             wp.created_at, wp.updated_at,
             snippet(wiki_pages_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
             rank
      FROM wiki_pages_fts fts
      JOIN wiki_pages wp ON wp.rowid = fts.rowid
      WHERE wiki_pages_fts MATCH ? AND wp.project_id = ?
      ORDER BY rank
      LIMIT ?
    `).all(query, projectId, limit);
    return results;
  } catch {
    // Fallback to LIKE search if FTS fails
    const results = db.prepare(`
      SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at
      FROM wiki_pages
      WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(projectId, `%${query}%`, `%${query}%`, limit);
    return results;
  }
}

/**
 * Get wiki context for system prompt (summaries of all pages)
 */
export function getWikiContext(projectId) {
  const pages = listPages(projectId);
  if (pages.length === 0) return '';

  const lines = pages.map(p => `- **${p.title}** (${p.category}) — updated ${p.updated_at}`);
  return `## Project Wiki (${pages.length} pages)\nUse the \`wiki_search\` skill to query relevant pages.\n${lines.join('\n')}`;
}

export { CATEGORIES };
