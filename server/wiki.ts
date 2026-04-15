import { db, stmts } from './db.js';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { WikiPageRow, Stmts } from './types.js';

const CATEGORIES = [
  'general',
  'api-docs',
  'architecture',
  'conventions',
  'test-patterns',
  'troubleshooting',
  'onboarding',
] as const;

type WikiCategory = (typeof CATEGORIES)[number];

interface CreatePageOptions {
  title: string;
  content?: string;
  category?: string;
  updatedBy?: string;
}

interface UpdatePageOptions {
  title?: string;
  content?: string;
  category?: string;
  updatedBy?: string;
}

interface CreatedPage {
  id: string;
  slug: string;
  title: string;
  content: string;
  category: string;
  updatedBy: string;
}

interface WikiSearchResult extends Omit<WikiPageRow, 'content'> {
  snippet?: string;
  rank?: number;
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function listPages(projectId: string): WikiPageRow[] {
  return (stmts as Stmts).getWikiPages.all(projectId) as WikiPageRow[];
}

export function getPage(projectId: string, slug: string): WikiPageRow | null {
  return ((stmts as Stmts).getWikiPage.get(projectId, slug) as WikiPageRow | undefined) || null;
}

export function createPage(
  projectId: string,
  { title, content = '', category = 'general', updatedBy = 'user' }: CreatePageOptions,
): CreatedPage {
  const id = crypto.randomUUID();
  const slug = slugify(title);

  const existing = (stmts as Stmts).getWikiPage.get(projectId, slug) as WikiPageRow | undefined;
  if (existing) {
    throw new Error(`A page with slug "${slug}" already exists in this project`);
  }

  (stmts as Stmts).createWikiPage.run(id, projectId, title, slug, content, category, updatedBy);

  try {
    (db as Database.Database)
      .prepare(
        'INSERT INTO wiki_pages_fts (rowid, title, content, slug, project_id) VALUES ((SELECT rowid FROM wiki_pages WHERE id = ?), ?, ?, ?, ?)',
      )
      .run(id, title, content, slug, projectId);
  } catch {
    /* FTS table might not exist yet */
  }

  return { id, slug, title, content, category, updatedBy };
}

export function updatePage(
  projectId: string,
  slug: string,
  { title, content, category, updatedBy = 'user' }: UpdatePageOptions,
): CreatedPage {
  const existing = (stmts as Stmts).getWikiPage.get(projectId, slug) as WikiPageRow | undefined;
  if (!existing) throw new Error(`Page "${slug}" not found`);

  const newTitle = title ?? existing.title;
  const newContent = content ?? existing.content;
  const newCategory = category ?? existing.category;
  const newSlug = title ? slugify(title) : slug;

  if (newSlug !== slug) {
    const conflict = (stmts as Stmts).getWikiPage.get(projectId, newSlug) as
      | WikiPageRow
      | undefined;
    if (conflict) throw new Error(`A page with slug "${newSlug}" already exists`);
  }

  if (newSlug !== slug) {
    (db as Database.Database)
      .prepare('DELETE FROM wiki_pages WHERE project_id = ? AND slug = ?')
      .run(projectId, slug);
    (stmts as Stmts).createWikiPage.run(
      existing.id,
      projectId,
      newTitle,
      newSlug,
      newContent,
      newCategory,
      updatedBy,
    );
  } else {
    (stmts as Stmts).updateWikiPage.run(
      newTitle,
      newContent,
      newCategory,
      updatedBy,
      projectId,
      slug,
    );
  }

  try {
    const rowResult = (db as Database.Database)
      .prepare('SELECT rowid FROM wiki_pages WHERE id = ?')
      .get(existing.id) as { rowid: number } | undefined;
    if (rowResult?.rowid) {
      (db as Database.Database)
        .prepare('DELETE FROM wiki_pages_fts WHERE rowid = ?')
        .run(rowResult.rowid);
      (db as Database.Database)
        .prepare(
          'INSERT INTO wiki_pages_fts (rowid, title, content, slug, project_id) VALUES (?, ?, ?, ?, ?)',
        )
        .run(rowResult.rowid, newTitle, newContent, newSlug, projectId);
    }
  } catch {
    /* FTS might not exist */
  }

  return {
    id: existing.id,
    slug: newSlug,
    title: newTitle,
    content: newContent,
    category: newCategory,
    updatedBy,
  };
}

export function deletePage(projectId: string, slug: string): boolean {
  const existing = (stmts as Stmts).getWikiPage.get(projectId, slug) as WikiPageRow | undefined;
  if (!existing) return false;

  try {
    const rowResult = (db as Database.Database)
      .prepare('SELECT rowid FROM wiki_pages WHERE id = ?')
      .get(existing.id) as { rowid: number } | undefined;
    if (rowResult?.rowid) {
      (db as Database.Database)
        .prepare('DELETE FROM wiki_pages_fts WHERE rowid = ?')
        .run(rowResult.rowid);
    }
  } catch {
    /* skip */
  }

  (stmts as Stmts).deleteWikiPage.run(projectId, slug);
  return true;
}

export function searchPages(projectId: string, query: string, limit = 10): WikiSearchResult[] {
  if (!query || !query.trim()) return listPages(projectId);

  try {
    const results = (db as Database.Database)
      .prepare(
        `
      SELECT wp.id, wp.project_id, wp.title, wp.slug, wp.category, wp.updated_by,
             wp.created_at, wp.updated_at,
             snippet(wiki_pages_fts, 1, '<mark>', '</mark>', '...', 40) as snippet,
             rank
      FROM wiki_pages_fts fts
      JOIN wiki_pages wp ON wp.rowid = fts.rowid
      WHERE wiki_pages_fts MATCH ? AND wp.project_id = ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(query, projectId, limit) as WikiSearchResult[];
    return results;
  } catch {
    const results = (db as Database.Database)
      .prepare(
        `
      SELECT id, project_id, title, slug, category, updated_by, created_at, updated_at
      FROM wiki_pages
      WHERE project_id = ? AND (title LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC
      LIMIT ?
    `,
      )
      .all(projectId, `%${query}%`, `%${query}%`, limit) as WikiSearchResult[];
    return results;
  }
}

export function getWikiContext(projectId: string): string {
  const pages = listPages(projectId);
  if (pages.length === 0) return '';

  const lines = pages.map((p) => `- **${p.title}** (${p.category}) — updated ${p.updated_at}`);
  return `## Project Wiki (${pages.length} pages)\nUse the \`wiki_search\` skill to query relevant pages.\n${lines.join('\n')}`;
}

export { CATEGORIES };
