// Pure view-model helpers for the session Artifacts panel. No React / DOM /
// network here so they're cheap to unit test and shared verbatim by the web
// client (SessionArtifactsPane) and the mobile app (SessionArtifactsPanel).

/** Human-readable byte size: 0 B, 512 B, 1.0 KB, 3.4 MB, … */
export function formatBytes(bytes: any) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let val = n / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i += 1;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

/** Lowercased extension (no dot) from a filename, or '' when none. */
export function extOf(filename: any) {
  if (typeof filename !== 'string') return '';
  const base = filename.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/**
 * Whether the client can SAFELY render this artifact inline (so "View" opens
 * it rather than forcing a download).
 *
 * Artifacts are agent-controlled and the web `viewArtifact` opens a same-origin
 * blob URL, so we must NEVER offer inline View for active/scriptable content —
 * HTML, SVG, XML, JS — which could run in the app origin on click. This is a
 * strict allowlist of non-active, natively-renderable types (no `text/*` /
 * `image/*` prefix matching, no `svg`). The server enforces the same boundary
 * (forces attachment + nosniff for active content); keep the two in sync.
 */
const INLINE_VIEWABLE_TYPES = new Set([
  'application/pdf',
  // Safe raster image formats only — NOT image/svg+xml (scriptable).
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  // Inert text shown as plain text by the browser — NOT text/html / text/xml.
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
]);

const INLINE_VIEWABLE_EXTS = [
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'txt',
  'md',
  'csv',
  'json',
];

export function isInlineViewable(contentType: any, filename: any) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (INLINE_VIEWABLE_TYPES.has(ct)) return true;
  // Fall back to a safe extension allowlist only when the server stored a
  // generic octet-stream (or no type). A known-but-unlisted type (e.g.
  // text/html, image/svg+xml) is intentionally NOT viewable.
  if (ct === 'application/octet-stream' || ct === '') {
    return INLINE_VIEWABLE_EXTS.includes(extOf(filename));
  }
  return false;
}

/**
 * A short emoji glyph for the artifact, chosen by MIME family then extension.
 * Purely cosmetic — keeps the list scannable without bundling an icon set.
 */
export function artifactGlyph(contentType: any, filename: any) {
  const ct = (contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/pdf') return '📄';
  if (ct.startsWith('image/')) return '🖼️';
  if (ct.startsWith('video/')) return '🎬';
  if (ct.startsWith('audio/')) return '🎵';
  if (ct === 'application/zip' || ct === 'application/gzip' || ct === 'application/x-gzip')
    return '🗜️';
  const ext = extOf(filename);
  if (['sh', 'js', 'ts', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'jsx', 'tsx'].includes(ext))
    return '📜';
  if (['csv', 'xlsx', 'xls'].includes(ext)) return '📊';
  if (['md', 'txt', 'json', 'yaml', 'yml'].includes(ext) || ct.startsWith('text/')) return '📝';
  return '📎';
}
