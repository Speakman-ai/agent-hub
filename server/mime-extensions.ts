/**
 * Shared MIME → file-extension helpers.
 *
 * Two surfaces need to turn a content type into a sensible file extension:
 * the `/api/upload` route (which names the file it writes to disk) and the
 * session artifacts route (which guarantees every stored artifact carries an
 * extension so downloads open in the right app). Keep the map in one place so
 * both stay in sync.
 */
import path from 'path';

export const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'text/html': 'html',
  'application/json': 'json',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-tar': 'tar',
  'application/javascript': 'js',
  'text/css': 'css',
};

/**
 * Extension (no leading dot, lowercase) → canonical MIME type. Used to
 * reconcile a stored/declared content type against the filename when the
 * declared type is missing or a generic `application/octet-stream` — so a PDF
 * named `report.pdf` always serves as `application/pdf` and renders inline
 * rather than downloading as an opaque blob. This is the reverse direction of
 * `MIME_TO_EXT`, plus a few extra extensions that share a canonical type.
 */
export const EXT_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
  pdf: 'application/pdf',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  js: 'application/javascript',
  mjs: 'application/javascript',
  css: 'text/css',
};

/**
 * True when `contentType` is missing or a generic catch-all
 * (`application/octet-stream`, `binary/octet-stream`) — i.e. it tells the
 * browser nothing about how to render the bytes.
 */
export function isGenericContentType(contentType: string | null | undefined): boolean {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  return !t || t === 'application/octet-stream' || t === 'binary/octet-stream';
}

/**
 * Canonical MIME type for a filename's extension, or `null` when the extension
 * is unknown / absent.
 */
export function contentTypeForFilename(name: string): string | null {
  const base = path.basename((name || '').trim());
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_MIME[ext] || null;
}

/**
 * Reconcile a declared content type against the filename so a file's type
 * always matches what its name claims to be.
 *
 * The filename extension is authoritative when it maps to a known type: a
 * `report.pdf` is served as `application/pdf` even when the uploader declared
 * something else (or a generic `application/octet-stream`) — this is what
 * guarantees PDFs always carry the correct type. This is safe because the
 * content route sets `X-Content-Type-Options: nosniff` (the browser won't
 * reinterpret the bytes) and routes any *active* reconciled type
 * (e.g. `.html` → `text/html`) through the active-content attachment guard.
 *
 * When the extension is unknown or absent, an explicit non-generic declared
 * type is trusted as-is (parameters preserved); a missing or generic type
 * falls back to `application/octet-stream`.
 */
export function reconcileContentType(
  contentType: string | null | undefined,
  filename: string,
): string {
  const fromExt = contentTypeForFilename(filename);
  if (fromExt) return fromExt;
  if (!isGenericContentType(contentType)) return contentType as string;
  return 'application/octet-stream';
}

/**
 * Best-effort extension (no leading dot) for a content type. Falls back to any
 * usable extension already on `originalName`, then to a text-subtype guess, and
 * finally to `dat`. Never returns an empty string.
 */
export function extensionForContentType(contentType: string, originalName = ''): string {
  const t = (contentType || '').split(';')[0].trim().toLowerCase();
  if (MIME_TO_EXT[t]) return MIME_TO_EXT[t];
  const ext = path.extname(path.basename(originalName)).replace(/^\./, '').toLowerCase();
  if (ext && /^[a-z0-9]{1,12}$/.test(ext)) return ext;
  if (t.startsWith('text/')) {
    const sub = t.slice(5);
    const safe = sub.replace(/\+xml$/i, '').replace(/[^a-z0-9]/g, '');
    if (safe.length >= 1 && safe.length <= 16) return safe;
    return 'txt';
  }
  return 'dat';
}

/**
 * True when `name`'s basename already ends in a plausible extension
 * (`.` followed by 1–12 alphanumerics). Dotfiles (`.gitignore`) and
 * trailing-dot names (`report.`) count as having none.
 */
export function hasFileExtension(name: string): boolean {
  const base = path.basename(name.trim());
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  const ext = base.slice(dot + 1);
  return /^[A-Za-z0-9]{1,12}$/.test(ext);
}

/**
 * Truncate `name` to at most `maxLength` characters while keeping its
 * extension. Trims the basename rather than the suffix, so a length cap can
 * never strip the extension the caller just guaranteed. Falls back to a plain
 * slice only when the extension itself would not leave room for any basename.
 */
export function truncateFilename(name: string, maxLength: number): string {
  if (maxLength <= 0 || name.length <= maxLength) return name;
  const base = path.basename(name);
  const dot = base.lastIndexOf('.');
  if (dot > 0) {
    const ext = base.slice(dot); // includes the leading dot, e.g. ".pdf"
    // Keep the extension only if at least one basename char survives with it.
    if (ext.length <= maxLength - 1) {
      return name.slice(0, maxLength - ext.length) + ext;
    }
  }
  return name.slice(0, maxLength);
}

/**
 * Guarantee `filename` carries a file extension, deriving one from
 * `contentType` when it lacks one. A blank name becomes `artifact.<ext>`.
 * When `maxLength` is given the result is capped to it without dropping the
 * extension (the basename is trimmed instead).
 */
export function ensureFilenameExtension(
  filename: string,
  contentType: string,
  maxLength?: number,
): string {
  const name = (filename || '').trim() || 'artifact';
  let result: string;
  if (hasFileExtension(name)) {
    result = name;
  } else {
    const ext = extensionForContentType(contentType, name);
    const base = name.replace(/\.+$/, '') || 'artifact';
    result = `${base}.${ext}`;
  }
  return maxLength ? truncateFilename(result, maxLength) : result;
}

/**
 * Detect an inert media type from a buffer's leading bytes. Only image and PDF
 * signatures are recognised; anything else (including active content) returns
 * `null`. Used when an uploader declared a generic type, which happens whenever
 * the host running `artifacts.sh` has no `file` binary.
 */
export function sniffContentType(buf: Buffer | Uint8Array | null | undefined): string | null {
  if (!buf || buf.length < 4) return null;
  const at = (i: number) => buf[i];
  if (
    buf.length >= 8 &&
    at(0) === 0x89 &&
    at(1) === 0x50 &&
    at(2) === 0x4e &&
    at(3) === 0x47 &&
    at(4) === 0x0d &&
    at(5) === 0x0a &&
    at(6) === 0x1a &&
    at(7) === 0x0a
  ) {
    return 'image/png';
  }
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (
    buf.length >= 12 &&
    at(0) === 0x52 &&
    at(1) === 0x49 &&
    at(2) === 0x46 &&
    at(3) === 0x46 &&
    at(8) === 0x57 &&
    at(9) === 0x45 &&
    at(10) === 0x42 &&
    at(11) === 0x50
  ) {
    return 'image/webp';
  }
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46) {
    return 'application/pdf';
  }
  return null;
}
