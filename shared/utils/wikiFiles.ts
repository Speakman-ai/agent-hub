/**
 * Client-side helpers for wiki file uploads, shared by web and mobile.
 * Folders are implicit: they exist because a file's `folder` names them.
 */

export interface WikiFileWire {
  id: string;
  project_id: string;
  folder: string;
  filename: string;
  path: string;
  content_type: string;
  size_bytes: number;
  page_id: string | null;
  page_slug: string | null;
  extracted_chars: number;
  truncated: number;
  uploaded_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface WikiFolderNode {
  /** Full slash-separated path; `''` for the root. */
  path: string;
  name: string;
  depth: number;
  folders: WikiFolderNode[];
  files: WikiFileWire[];
  /** Files in this folder and every descendant. */
  totalFiles: number;
}

/** Build a sorted folder tree from a flat file list. */
export function buildWikiFolderTree(files: WikiFileWire[]): WikiFolderNode {
  const root: WikiFolderNode = {
    path: '',
    name: '',
    depth: 0,
    folders: [],
    files: [],
    totalFiles: 0,
  };
  const byPath = new Map<string, WikiFolderNode>([['', root]]);

  const ensure = (folderPath: string): WikiFolderNode => {
    const existing = byPath.get(folderPath);
    if (existing) return existing;
    const idx = folderPath.lastIndexOf('/');
    const parent = ensure(idx === -1 ? '' : folderPath.slice(0, idx));
    const node: WikiFolderNode = {
      path: folderPath,
      name: idx === -1 ? folderPath : folderPath.slice(idx + 1),
      depth: parent.depth + 1,
      folders: [],
      files: [],
      totalFiles: 0,
    };
    parent.folders.push(node);
    byPath.set(folderPath, node);
    return node;
  };

  for (const file of files) {
    const node = ensure(file.folder || '');
    node.files.push(file);
    for (let p: string | null = node.path; p !== null; ) {
      byPath.get(p)!.totalFiles += 1;
      if (p === '') p = null;
      else {
        const i = p.lastIndexOf('/');
        p = i === -1 ? '' : p.slice(0, i);
      }
    }
  }

  const sortNode = (node: WikiFolderNode): void => {
    node.folders.sort((a, b) => a.name.localeCompare(b.name));
    node.files.sort((a, b) => a.filename.localeCompare(b.filename));
    node.folders.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/** Every folder path in the tree (excluding root), depth-first, for pickers. */
export function listWikiFolderPaths(root: WikiFolderNode): string[] {
  const out: string[] = [];
  const walk = (n: WikiFolderNode): void => {
    for (const f of n.folders) {
      out.push(f.path);
      walk(f);
    }
  };
  walk(root);
  return out;
}

/** Normalize a folder typed by the user so it matches what the server stores. */
export function normalizeWikiFolderInput(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s && s !== '.')
    .join('/');
}

export function formatWikiFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** File extensions the server can extract text from (used for picker filters). */
export const WIKI_FILE_ACCEPT = [
  '.pdf',
  '.docx',
  '.md',
  '.markdown',
  '.txt',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.html',
  '.htm',
  '.log',
  '.rst',
];

/** Build the upload URL; the body is the raw file bytes. */
export function wikiFileUploadUrl(
  apiBase: string,
  projectId: string,
  folder: string,
  filename: string,
): string {
  const q = new URLSearchParams({ filename });
  const f = normalizeWikiFolderInput(folder);
  if (f) q.set('folder', f);
  return `${apiBase}/projects/${encodeURIComponent(projectId)}/wiki-files?${q.toString()}`;
}

/** Upload attempts made when the server answers 503 (busy). */
export const WIKI_UPLOAD_MAX_ATTEMPTS = 4;

/**
 * Delay before retrying a busy (503) upload: the server's Retry-After (in
 * seconds) when present, else exponential backoff, capped at 30s.
 */
export function wikiUploadRetryDelayMs(
  retryAfter: string | null | undefined,
  attempt: number,
): number {
  const seconds = Number(retryAfter);
  const base = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 1000 * 2 ** attempt;
  return Math.min(base, 30_000);
}

/**
 * One user-facing message for a failed wiki-file action, whatever failed:
 * the server's `error` text when it sent one, else the HTTP status, else the
 * transport error (offline, DNS, connection reset).
 */
export function wikiFileActionError(
  action: string,
  failure: { status?: number; body?: unknown; network?: unknown },
): string {
  const serverMessage =
    failure.body && typeof (failure.body as { error?: unknown }).error === 'string'
      ? (failure.body as { error: string }).error
      : null;
  if (serverMessage) return `${action} failed: ${serverMessage}`;
  if (failure.status) return `${action} failed (HTTP ${failure.status})`;
  const reason = failure.network instanceof Error ? failure.network.message : 'network error';
  return `${action} failed: could not reach the server (${reason})`;
}
