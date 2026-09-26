/**
 * Wiki file uploads: documents stored in folders under a project's wiki.
 *
 * Each file has two halves:
 *  - the original bytes, kept in the upload store (local dir or S3) for download;
 *  - a linked wiki page (category `documents`) holding the extracted text.
 *
 * Because the text lives in a normal wiki page, FTS5, Gemini embeddings, the
 * automatic RAG pass, and the agent's `wiki` ReAct action all see uploaded
 * documents with no extra retrieval code.
 *
 * The `wiki_files` row is the single source of truth. The linked page's title
 * and content are a pure rendering of that row (`renderWikiFilePage`), and
 * every mutation that changes the row rewrites the page through
 * `writeWikiFilePage` in the same transaction. Nothing else may edit the page
 * text of a file, so the page can never describe a stale path or revision.
 */
import crypto from 'crypto';
import path from 'path';
import { getDb, getStmts } from './db.js';
import type { WikiFileRow, WikiPageRow } from './types.js';
import { createPage, deletePage, getPage, syncWikiPageFts } from './wiki.js';
import { scheduleEmbedPage } from './wiki-embeddings.js';
import { extractWikiFileText, detectWikiFileKind } from './wiki-file-extract.js';
import { fileURLToPath } from 'url';
import { createUploadStore, type UploadStore } from './upload-store.js';
import { resolveUploadsDir } from './uploads-dir.js';
import appConfig from './config.js';
import type { AppConfig } from './types.js';
import { reconcileContentType } from './mime-extensions.js';
import { AdmissionGate, throwIfCancelled } from './upload-admission.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export const WIKI_FILES_CATEGORY = 'documents';
export const MAX_WIKI_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Whole-request admission for uploads, taken before the body is read. At
 * most `maxActive` bodies (each ≤ MAX_WIKI_FILE_BYTES) are ever buffered;
 * queued requests hold only their sockets, and overflow gets a 503.
 */
export const wikiUploadGate = new AdmissionGate({
  name: 'Wiki file uploads',
  maxActive: 2,
  maxQueued: 4,
  maxWaitMs: 30_000,
});

/** Downloads buffer the whole file too, so they get the same treatment. */
export const wikiDownloadGate = new AdmissionGate({
  name: 'Wiki file downloads',
  maxActive: 4,
  maxQueued: 8,
  maxWaitMs: 30_000,
});

const MAX_FOLDER_DEPTH = 10;
const MAX_SEGMENT_CHARS = 100;
const MAX_FILENAME_CHARS = 200;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export class WikiFileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikiFileInputError';
  }
}

/**
 * Normalize a user-supplied folder path to `A/B/C` form: backslashes become
 * slashes, empty and `.` segments drop out, and `..` is rejected so a folder
 * can never be used to name something outside the wiki tree.
 */
export function normalizeWikiFolder(raw: string | null | undefined): string {
  if (!raw) return '';
  const segments = raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.replace(CONTROL_CHARS, '').trim())
    .filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) {
    throw new WikiFileInputError('Folder path may not contain ".."');
  }
  if (segments.length > MAX_FOLDER_DEPTH) {
    throw new WikiFileInputError(`Folder path may be at most ${MAX_FOLDER_DEPTH} levels deep`);
  }
  if (segments.some((s) => s.length > MAX_SEGMENT_CHARS)) {
    throw new WikiFileInputError(`Folder names may be at most ${MAX_SEGMENT_CHARS} characters`);
  }
  return segments.join('/');
}

/** Strip any path component and control characters from an uploaded filename. */
export function normalizeWikiFilename(raw: string | null | undefined): string {
  const base = (raw ?? '').replace(/\\/g, '/').split('/').pop()!.replace(CONTROL_CHARS, '').trim();
  if (!base || base === '.' || base === '..') {
    throw new WikiFileInputError('A filename is required');
  }
  if (base.length > MAX_FILENAME_CHARS) {
    throw new WikiFileInputError(`Filename may be at most ${MAX_FILENAME_CHARS} characters`);
  }
  return base;
}

export function wikiFilePath(folder: string, filename: string): string {
  return folder ? `${folder}/${filename}` : filename;
}

function storageNameFor(id: string, filename: string): string {
  const ext = path
    .extname(filename)
    .slice(1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  return ext ? `wikifile-${id}.${ext}` : `wikifile-${id}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type RenderableFile = Pick<
  WikiFileRow,
  'folder' | 'filename' | 'content_type' | 'size_bytes' | 'extracted_text' | 'truncated'
>;

/** Title and content of a file's linked page, derived only from the file row. */
export function renderWikiFilePage(file: RenderableFile): { title: string; content: string } {
  const filePath = wikiFilePath(file.folder, file.filename);
  const kind = detectWikiFileKind(file.filename, file.content_type) ?? 'text';
  const header = `_Uploaded file: **${filePath}** (${kind.toUpperCase()}, ${formatBytes(file.size_bytes)}). This page holds the extracted text for search; download the original from the wiki Files view._`;
  const body = file.extracted_text
    ? file.extracted_text
    : '_No extractable text was found in this file (it may be a scanned image)._';
  const tail = file.truncated
    ? '\n\n_Text was truncated because the file is very large; only the first part is indexed._'
    : '';
  return { title: filePath, content: `${header}\n\n${body}${tail}` };
}

/**
 * Create or rewrite the linked page for a file so it matches the row. An
 * existing page keeps its id and slug (links survive moves and revisions);
 * its title, content, FTS row, and embeddings are refreshed. Must run inside
 * the caller's transaction.
 */
function writeWikiFilePage(
  projectId: string,
  file: RenderableFile & { page_id: string | null },
  updatedBy: string,
): { id: string; slug: string; title: string } {
  const { title, content } = renderWikiFilePage(file);
  const existing = file.page_id
    ? (getStmts().getWikiPageById.get(file.page_id) as WikiPageRow | undefined)
    : undefined;
  if (!existing) {
    return createPage(projectId, {
      title: freePageTitle(projectId, title),
      content,
      category: WIKI_FILES_CATEGORY,
      updatedBy,
    });
  }
  getDb()
    .prepare(
      `UPDATE wiki_pages SET title = ?, content = ?, category = ?, updated_by = ?,
         updated_at = datetime('now') WHERE id = ?`,
    )
    .run(title, content, WIKI_FILES_CATEGORY, updatedBy, existing.id);
  syncWikiPageFts(existing.id, title, content, existing.slug, projectId);
  scheduleEmbedPage(projectId, { id: existing.id });
  return { id: existing.id, slug: existing.slug, title };
}

export type WikiFileView = Omit<WikiFileRow, 'extracted_text'> & {
  path: string;
  page_slug: string | null;
};

/** Every column except the (potentially large) extracted text. */
const VIEW_COLUMNS = `id, project_id, folder, filename, content_type, size_bytes, storage_key,
  page_id, extracted_chars, truncated, uploaded_by, created_at, updated_at`;

type WikiFileListRow = Omit<WikiFileRow, 'extracted_text'> & { extracted_text?: string };

function withPage(row: WikiFileListRow): WikiFileView {
  let pageSlug: string | null = null;
  if (row.page_id) {
    const page = getStmts().getWikiPageById.get(row.page_id) as WikiPageRow | undefined;
    pageSlug = page?.slug ?? null;
  }
  const { extracted_text: _text, ...rest } = row;
  return { ...rest, path: wikiFilePath(row.folder, row.filename), page_slug: pageSlug };
}

export function listWikiFiles(projectId: string, folder?: string): WikiFileView[] {
  const db = getDb();
  const rows =
    folder === undefined
      ? (db
          .prepare(
            `SELECT ${VIEW_COLUMNS} FROM wiki_files WHERE project_id = ? ORDER BY folder, filename`,
          )
          .all(projectId) as WikiFileListRow[])
      : (db
          .prepare(
            `SELECT ${VIEW_COLUMNS} FROM wiki_files WHERE project_id = ? AND folder = ? ORDER BY filename`,
          )
          .all(projectId, normalizeWikiFolder(folder)) as WikiFileListRow[]);
  return rows.map(withPage);
}

export function getWikiFile(projectId: string, id: string): WikiFileView | null {
  const row = getDb()
    .prepare(`SELECT ${VIEW_COLUMNS} FROM wiki_files WHERE project_id = ? AND id = ?`)
    .get(projectId, id) as WikiFileListRow | undefined;
  return row ? withPage(row) : null;
}

/**
 * Pick a page title for a new file. The file path is the natural title, but a
 * hand-written page may already own that slug; suffix a counter instead of
 * overwriting someone's page.
 */
function freePageTitle(projectId: string, filePath: string): string {
  const slugOf = (t: string) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  if (!getPage(projectId, slugOf(filePath))) return filePath;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${filePath} (${n})`;
    if (!getPage(projectId, slugOf(candidate))) return candidate;
  }
  return `${filePath} (${crypto.randomUUID().slice(0, 8)})`;
}

export interface SaveWikiFileInput {
  folder?: string | null;
  filename: string;
  contentType: string;
  body: Buffer;
  uploadedBy?: string | null;
  /** Aborted when the requesting client goes away; work stops at the next checkpoint. */
  signal?: AbortSignal;
}

export interface SaveWikiFileResult {
  file: WikiFileView;
  page: { id: string; slug: string; title: string };
  replaced: boolean;
}

/**
 * Store a file and index its text. Re-uploading the same folder + filename
 * replaces the bytes and rewrites the linked page in place, so the page slug
 * (and any links to it) survive a new revision of the SOP.
 */
export async function saveWikiFile(
  projectId: string,
  store: UploadStore,
  input: SaveWikiFileInput,
): Promise<SaveWikiFileResult> {
  const folder = normalizeWikiFolder(input.folder);
  const filename = normalizeWikiFilename(input.filename);
  if (input.body.length === 0) throw new WikiFileInputError('File is empty');
  if (input.body.length > MAX_WIKI_FILE_BYTES) {
    throw new WikiFileInputError(
      `File too large. Max size: ${MAX_WIKI_FILE_BYTES / 1024 / 1024}MB`,
    );
  }

  // Trust the extension over the declared type: web/mobile send octet-stream
  // so the global JSON parser never touches the body.
  const contentType = /\.docx$/i.test(filename)
    ? DOCX_MIME
    : reconcileContentType(input.contentType, filename);
  throwIfCancelled(input.signal);
  const extracted = await extractWikiFileText(input.body, filename, contentType, {
    signal: input.signal,
  });
  throwIfCancelled(input.signal);
  const updatedBy = input.uploadedBy || 'upload';

  // The only await is storing the bytes. Everything that depends on whether a
  // file already lives at this path (the lookup, page write, and row write)
  // runs afterwards in one synchronous transaction. Node cannot interleave
  // synchronous code, so two overlapping uploads of the same path serialize:
  // the second sees the first's committed row and becomes a replace instead of
  // tripping UNIQUE(project_id, folder, filename). Any failure rolls back the
  // page and row together and deletes the bytes this call stored.
  const storageKey = storageNameFor(crypto.randomUUID(), filename);
  await store.put(storageKey, input.body, contentType);
  if (input.signal?.aborted) {
    // Nobody is waiting for the result; don't commit a file the client gave up on.
    await store.delete(storageKey).catch(() => undefined);
    throwIfCancelled(input.signal);
  }

  const db = getDb();
  const commit = db.transaction(() => {
    const existing = db
      .prepare('SELECT * FROM wiki_files WHERE project_id = ? AND folder = ? AND filename = ?')
      .get(projectId, folder, filename) as WikiFileRow | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const fields = {
      folder,
      filename,
      content_type: contentType,
      size_bytes: input.body.length,
      extracted_text: extracted.text,
      truncated: extracted.truncated ? 1 : 0,
    };
    const page = writeWikiFilePage(
      projectId,
      { ...fields, page_id: existing?.page_id ?? null },
      updatedBy,
    );

    if (existing) {
      db.prepare(
        `UPDATE wiki_files SET content_type = ?, size_bytes = ?, storage_key = ?, page_id = ?,
           extracted_chars = ?, extracted_text = ?, truncated = ?, uploaded_by = ?,
           updated_at = datetime('now')
         WHERE id = ?`,
      ).run(
        contentType,
        input.body.length,
        storageKey,
        page.id,
        extracted.text.length,
        extracted.text,
        fields.truncated,
        input.uploadedBy ?? null,
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO wiki_files (id, project_id, folder, filename, content_type, size_bytes,
           storage_key, page_id, extracted_chars, extracted_text, truncated, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        projectId,
        folder,
        filename,
        contentType,
        input.body.length,
        storageKey,
        page.id,
        extracted.text.length,
        extracted.text,
        fields.truncated,
        input.uploadedBy ?? null,
      );
    }
    return { id, page, replacedKey: existing?.storage_key ?? null };
  });

  let committed: ReturnType<typeof commit>;
  try {
    committed = commit();
  } catch (err) {
    await store.delete(storageKey).catch(() => undefined);
    throw err;
  }

  if (committed.replacedKey && committed.replacedKey !== storageKey) {
    await store.delete(committed.replacedKey).catch(() => undefined);
  }

  const { id, page } = committed;
  return {
    file: getWikiFile(projectId, id)!,
    page: { id: page.id, slug: page.slug, title: page.title },
    replaced: committed.replacedKey !== null,
  };
}

/**
 * Move a file to another folder. The linked page keeps its slug; its title,
 * header, FTS row, and embeddings are rewritten to the new path in the same
 * transaction, so search never reports the old location.
 */
export function moveWikiFile(
  projectId: string,
  id: string,
  rawFolder: string,
  movedBy?: string | null,
): { file: WikiFileView; pageSlug: string | null } {
  const folder = normalizeWikiFolder(rawFolder);
  const db = getDb();
  return db.transaction(() => {
    const row = db
      .prepare('SELECT * FROM wiki_files WHERE project_id = ? AND id = ?')
      .get(projectId, id) as WikiFileRow | undefined;
    if (!row) throw new WikiFileInputError('File not found');
    if (folder === row.folder) {
      const file = withPage(row);
      return { file, pageSlug: file.page_slug };
    }
    const clash = db
      .prepare('SELECT id FROM wiki_files WHERE project_id = ? AND folder = ? AND filename = ?')
      .get(projectId, folder, row.filename);
    if (clash) {
      throw new WikiFileInputError(
        `A file named "${row.filename}" already exists in "${folder || '/'}"`,
      );
    }
    db.prepare("UPDATE wiki_files SET folder = ?, updated_at = datetime('now') WHERE id = ?").run(
      folder,
      id,
    );
    // An unlinked file (page deleted by hand) stays unindexed until re-upload.
    let pageSlug: string | null = null;
    if (row.page_id && getStmts().getWikiPageById.get(row.page_id)) {
      pageSlug = writeWikiFilePage(projectId, { ...row, folder }, movedBy || 'move').slug;
    }
    return { file: getWikiFile(projectId, id)!, pageSlug };
  })();
}

/** Delete a file, its stored bytes, and its linked page (with FTS + embeddings). */
export async function deleteWikiFile(
  projectId: string,
  store: UploadStore,
  id: string,
): Promise<{ deleted: boolean; pageSlug: string | null }> {
  const file = getWikiFile(projectId, id);
  if (!file) return { deleted: false, pageSlug: null };
  const db = getDb();
  db.transaction(() => {
    if (file.page_slug) deletePage(projectId, file.page_slug);
    db.prepare('DELETE FROM wiki_files WHERE id = ?').run(id);
  })();
  await store.delete(file.storage_key).catch((err: Error) => {
    console.warn(`[wiki-files] failed to delete stored bytes for ${id}:`, err.message);
  });
  return { deleted: true, pageSlug: file.page_slug };
}

const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
const storesByDir = new Map<string, UploadStore>();

/**
 * The store that holds wiki file bytes. Routes and the project-deletion
 * cascade both resolve it here so they always agree on where bytes live.
 */
let storeOverride: UploadStore | null = null;

/** Swap the byte store (tests use this to simulate slow or blocked storage). */
export function setWikiFileStoreOverride(store: UploadStore | null): void {
  storeOverride = store;
}

export function getWikiFileStore(
  config: Partial<AppConfig> = appConfig as Partial<AppConfig>,
  serverDir: string = SERVER_DIR,
): UploadStore {
  if (storeOverride) return storeOverride;
  const dir = resolveUploadsDir(config, serverDir);
  let store = storesByDir.get(dir);
  if (!store) {
    store = createUploadStore(config as AppConfig, dir);
    storesByDir.set(dir, store);
  }
  return store;
}

/**
 * Remove every file row for a deleted project and schedule deletion of the
 * stored bytes. Pages are removed by the caller's wiki cascade. Byte cleanup
 * is best-effort and never blocks project deletion.
 */
export function purgeProjectWikiFiles(
  projectId: string,
  store: UploadStore = getWikiFileStore(),
): void {
  const db = getDb();
  const keys = (
    db.prepare('SELECT storage_key FROM wiki_files WHERE project_id = ?').all(projectId) as {
      storage_key: string;
    }[]
  ).map((r) => r.storage_key);
  db.prepare('DELETE FROM wiki_files WHERE project_id = ?').run(projectId);
  for (const key of keys) {
    store.delete(key).catch((err: Error) => {
      console.warn(`[wiki-files] failed to delete bytes ${key} for ${projectId}:`, err.message);
    });
  }
}
