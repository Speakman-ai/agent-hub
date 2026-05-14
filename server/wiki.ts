import { db, stmts } from './db.js';
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import type { WikiPageRow, Stmts } from './types.js';
import { scheduleEmbedPage, deletePageEmbeddings } from './wiki-embeddings.js';

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

/**
 * Re-sync the `wiki_pages_fts` FTS5 index for a single wiki page. Idempotent:
 * deletes any prior FTS row for the page's rowid and inserts a fresh one.
 *
 * The FTS index is maintained out-of-band (no triggers — see `db.ts` where
 * the table is created with `content_rowid='rowid'` but no `INSERT/UPDATE`
 * triggers on `wiki_pages`). `createPage` / `updatePage` keep it in sync
 * inline, but the project-import path writes directly to `stmts.createWikiPage`
 * for batching reasons. That import path calls this helper to keep imported
 * pages searchable from the moment they land — otherwise FTS search returns
 * zero hits until the page is edited through the normal CRUD path.
 *
 * Failures are swallowed (logged via console.warn) so a malformed FTS table
 * on an older deploy never aborts the calling write — the row is already in
 * `wiki_pages` either way, and re-syncing on any subsequent edit recovers it.
 */
export function syncWikiPageFts(
  pageId: string,
  title: string,
  content: string,
  slug: string,
  projectId: string,
): void {
  try {
    const rowResult = (db as Database.Database)
      .prepare('SELECT rowid FROM wiki_pages WHERE id = ?')
      .get(pageId) as { rowid: number } | undefined;
    if (!rowResult?.rowid) return;
    (db as Database.Database)
      .prepare('DELETE FROM wiki_pages_fts WHERE rowid = ?')
      .run(rowResult.rowid);
    (db as Database.Database)
      .prepare(
        'INSERT INTO wiki_pages_fts (rowid, title, content, slug, project_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(rowResult.rowid, title, content, slug, projectId);
  } catch (e: unknown) {
    console.warn(`[wiki] FTS sync for page ${pageId} failed:`, (e as Error).message);
  }
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

  scheduleEmbedPage(projectId, { id, title, content });

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

  // Re-embed only if title or content changed — category/slug-only updates
  // don't affect semantic content.
  if (title !== undefined || content !== undefined) {
    scheduleEmbedPage(projectId, { id: existing.id, title: newTitle, content: newContent });
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

  try {
    deletePageEmbeddings(existing.id);
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

/**
 * Cap on how many wiki page titles we paste into the enriched system prompt.
 *
 * Before this cap, `getWikiContext` listed every page (148+ on mature
 * projects) every turn, costing 12 to 20 KB of metadata for a list the
 * agent rarely scans linearly. The `wiki_search` skill (and the
 * `<agenthub:react>` `wiki` action) cover the long tail on demand, so the
 * prompt only needs the most-recent slice to keep "what's new" awareness.
 *
 * Lowered from 25 to 10 in the May 2026 prompt-trim audit: at 25 the
 * listing still cost ~3 KB/turn for a 148-page wiki, and operationally
 * the agent uses `wiki_search` rather than scanning the inline list, so
 * the trim is neutral for retrieval and saves ~1.8 KB/turn.
 *
 * Exported so tests pin the constant.
 */
export const WIKI_CONTEXT_PAGE_CAP = 10;

type WikiContextPage = Pick<WikiPageRow, 'title' | 'category' | 'updated_at'>;

/**
 * Pure formatter for the wiki context block. Split out from
 * `getWikiContext` so it can be unit-tested without booting the SQLite
 * statements registry.
 *
 * Pages are expected to arrive sorted most-recent-first (matches
 * `getWikiPages`). When the list exceeds `cap`, only the top `cap`
 * entries are rendered and a single trailing line points at
 * `wiki_search` for the remainder.
 */
export function formatWikiContext(pages: WikiContextPage[], cap = WIKI_CONTEXT_PAGE_CAP): string {
  if (pages.length === 0) return '';
  const total = pages.length;
  const safeCap = Math.max(0, Math.floor(cap));
  const visible = safeCap > 0 ? pages.slice(0, safeCap) : [];
  const lines = visible.map((p) => `- **${p.title}** (${p.category}) — updated ${p.updated_at}`);
  const hiddenCount = total - visible.length;
  const header =
    hiddenCount > 0
      ? `## Project Wiki (${total} pages; ${visible.length} most-recent shown)\nUse the \`wiki_search\` skill (or the \`<agenthub:react>\` \`wiki\` action) to retrieve any of the remaining ${hiddenCount} pages on demand.`
      : `## Project Wiki (${total} pages)\nUse the \`wiki_search\` skill to query relevant pages.`;
  return lines.length > 0 ? `${header}\n${lines.join('\n')}` : header;
}

export function getWikiContext(projectId: string): string {
  const pages = listPages(projectId);
  return formatWikiContext(pages);
}

export { CATEGORIES };
