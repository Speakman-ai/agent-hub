/**
 * Pure helpers for the mobile design-mode files panel (SessionDesignFilesPanel).
 * Kept under utils/ so they unit-test without importing React Native.
 */
/**
 * Build the open-in-browser URL for a design artifact at relative path `p`.
 *
 * Each path segment is URL-encoded — artifact names under the worktree `design/`
 * dir may contain spaces or URL-significant chars like `#`, `?`, `%` — while `/`
 * separators are preserved so the `/session-files/:id/design/` static mount
 * still resolves the nested path. Returns null when no server base is configured.
 *
 * @param {string} base server root URL (no trailing slash), or '' when unset.
 * @param {string} sessionId session whose worktree design/ dir is served.
 * @param {string} p forward-slash path relative to the design/ dir.
 * @returns {string|null}
 */
export function buildDesignFileUrl(base: any, sessionId: any, p: any) {
  if (!base) return null;
  const encoded = String(p).split('/').map(encodeURIComponent).join('/');
  return `${base}/session-files/${sessionId}/design/${encoded}`;
}
/**
 * The artifact treated as the design's entry point for "open in browser":
 * `index.html` (root or nested) if present, else the first `.html` file, else
 * null. `files` is the `{ path, size, mtime }[]` listing from the server.
 *
 * @param {{ path: string }[]} files
 * @returns {string|null}
 */
export function pickEntryFile(files: any) {
  if (!files?.length) return null;
  const index = files.find((f: any) => f.path === 'index.html' || f.path.endsWith('/index.html'));
  if (index) return index.path;
  const html = files.find((f: any) => f.path.toLowerCase().endsWith('.html'));
  return html ? html.path : null;
}
/**
 * Human-readable file size (B / KB / MB). Returns '' for null/NaN.
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes: any) {
  if (bytes == null || Number.isNaN(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
