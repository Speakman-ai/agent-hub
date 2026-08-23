/**
 * Support-ticket screenshot attachment helper.
 *
 * The project-scoped support-ticket intake (and PATCH) accepts an optional
 * screenshot as a base64 `data:` URL in the JSON body. This module is the one
 * place that validates that payload (mime + decoded size) and persists it to
 * the server's `/uploads` directory, returning the server-relative ref stored
 * on the ticket's `screenshot_ref` column.
 *
 * Keeping parse/validate/persist here (instead of inline in the route) means the
 * size/mime guard and the on-disk naming convention can't drift between the POST
 * and PATCH entry points, and the pure parser is unit-testable without touching
 * the filesystem.
 */
import path from 'path';
import { mkdirSync } from 'fs';
import { writeFile, unlink } from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';

/** Max decoded screenshot size. Comfortably fits a full-page PNG screenshot
 *  while staying well under the 20 MB global JSON body limit (a base64 payload
 *  is ~4/3 the decoded size). */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

/** Allowed image mime types → file extension. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ParsedScreenshot {
  mime: string;
  ext: string;
  buffer: Buffer;
}

/**
 * Sniff the image format from the decoded bytes' magic signature, returning the
 * canonical mime or null if the bytes are not one of the allowed image formats.
 *
 * The declared data-URL mime is attacker-controlled, so we never trust it on its
 * own: matching the real signature is what stops the intake endpoint from
 * becoming an arbitrary-blob upload path under /uploads (and prevents broken
 * thumbnails from a payload that lies about its type).
 */
export function sniffImageMime(buf: Buffer): string | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  // GIF: "GIF87a" or "GIF89a"
  if (buf.length >= 6) {
    const sig = buf.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  // WebP: "RIFF" <4-byte size> "WEBP"
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/**
 * Strictly decode a base64 payload, rejecting anything that isn't canonical.
 *
 * `Buffer.from(s, 'base64')` is lenient: it silently drops characters outside
 * the base64 alphabet and tolerates wrong padding, so a corrupt payload like
 * `abcd!!!!` would decode to bytes and be persisted as a bogus "image". Because
 * this endpoint exists to validate uploaded image data, we instead:
 *  1. require the canonical base64 alphabet, a length that's a multiple of 4,
 *     and padding only at the very end; then
 *  2. round-trip the decoded bytes back to base64 and require an exact match,
 *     which rejects non-canonical encodings (e.g. stray low-order bits in the
 *     final quantum) that the regex alone would let through.
 */
function decodeStrictBase64(b64: string): Buffer {
  if (b64.length === 0 || b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {
    throw new Error('screenshot base64 payload is invalid');
  }
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length === 0) {
    throw new Error('screenshot base64 payload is empty');
  }
  if (buffer.toString('base64') !== b64) {
    throw new Error('screenshot base64 payload is not canonical');
  }
  return buffer;
}

/**
 * Parse and validate a base64 image `data:` URL.
 *
 * Throws an `Error` with a caller-friendly message on any malformed input,
 * disallowed mime type, or oversize payload — the route maps it to a 400/413.
 * Returns the decoded buffer plus its resolved mime / extension on success.
 */
export function parseScreenshotDataUrl(raw: string): ParsedScreenshot {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('screenshot must be a non-empty data URL');
  }
  // data:image/png;base64,<payload>
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(raw.trim());
  if (!match) {
    throw new Error('screenshot must be a base64 data URL (data:image/<type>;base64,<data>)');
  }
  const mime = match[1]!.toLowerCase();
  const ext = EXT_BY_MIME[mime];
  if (!ext) {
    throw new Error(`screenshot mime must be one of: ${Object.keys(EXT_BY_MIME).join(', ')}`);
  }
  const buffer = decodeStrictBase64(match[2]!);
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    const mb = (MAX_SCREENSHOT_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`screenshot exceeds the ${mb} MB limit`);
  }
  // The declared mime passed the allow-list, but the bytes must actually BE that
  // image format — otherwise the endpoint would persist arbitrary blobs as
  // images. Require the magic-byte signature to match the declared type.
  const detected = sniffImageMime(buffer);
  if (!detected) {
    throw new Error('screenshot is not a recognized image (png, jpeg, webp, gif)');
  }
  if (detected !== mime) {
    throw new Error(`screenshot bytes are ${detected} but the data URL declared ${mime}`);
  }
  return { mime, ext, buffer };
}

/**
 * Validate already-decoded image bytes the same way {@link parseScreenshotDataUrl}
 * validates a data URL: non-empty, within the size cap, and a recognized image
 * format by magic-byte signature. The declared content-type (from a multipart
 * part, say) is never trusted — only the sniffed signature decides the mime, so
 * this can't become an arbitrary-blob upload path. Returns the canonical mime +
 * extension; throws an `Error` with a caller-friendly message otherwise.
 */
export function validateScreenshotBuffer(buffer: Buffer): { mime: string; ext: string } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('screenshot is empty');
  }
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    const mb = (MAX_SCREENSHOT_BYTES / (1024 * 1024)).toFixed(0);
    throw new Error(`screenshot exceeds the ${mb} MB limit`);
  }
  const mime = sniffImageMime(buffer);
  if (!mime) {
    throw new Error('screenshot is not a recognized image (png, jpeg, webp, gif)');
  }
  return { mime, ext: EXT_BY_MIME[mime]! };
}

/** Write validated image bytes under the configured uploads directory, returning the
 *  server-relative `screenshot_ref` to store on the ticket. */
async function writeScreenshot(uploadsDir: string, buffer: Buffer, ext: string): Promise<string> {
  mkdirSync(uploadsDir, { recursive: true });
  const filename = `support-screenshot-${uuidv4()}.${ext}`;
  // Async write: a screenshot can be several MB and this runs on a public
  // intake path; persisting it must not block the event loop.
  await writeFile(path.join(uploadsDir, filename), buffer);
  return `/uploads/${filename}`;
}

/**
 * Validate + persist a screenshot data URL under the configured uploads directory.
 * Returns the server-relative ref (`/uploads/support-screenshot-<id>.<ext>`)
 * to store on the ticket. Throws (via {@link parseScreenshotDataUrl}) on
 * invalid input so the caller can map it to a 4xx.
 */
export async function persistSupportTicketScreenshot(
  uploadsDir: string,
  dataUrl: string,
): Promise<string> {
  const { ext, buffer } = parseScreenshotDataUrl(dataUrl);
  return writeScreenshot(uploadsDir, buffer, ext);
}

/**
 * Validate + persist raw image bytes (e.g. a `multipart/form-data` file part)
 * under the configured uploads directory, returning the server-relative ref. Unlike
 * {@link persistSupportTicketScreenshot} the input is the decoded buffer, not a
 * base64 data URL — used by the public bug-report intake, which parses multipart
 * bytes directly. Throws (via {@link validateScreenshotBuffer}) on invalid input.
 */
export async function persistSupportTicketScreenshotBuffer(
  uploadsDir: string,
  buffer: Buffer,
): Promise<string> {
  const { ext } = validateScreenshotBuffer(buffer);
  return writeScreenshot(uploadsDir, buffer, ext);
}

/**
 * Only match the exact `/uploads/support-screenshot-<name>` shape this module
 * produces, so the deleter can never be tricked into unlinking an arbitrary
 * file (path traversal, another feature's upload, etc.).
 */
const SCREENSHOT_REF_RE = /^\/uploads\/(support-screenshot-[A-Za-z0-9._-]+)$/;

/**
 * Best-effort removal of a previously-persisted screenshot file. Used to roll
 * back an orphaned upload when a ticket create/patch fails after the file was
 * written, and to clean up the prior file when a ticket's screenshot is
 * replaced or cleared. No-ops on a null/empty ref, a ref that doesn't match the
 * support-screenshot naming, or a missing file — it never throws, so it can't
 * mask the original outcome of the request.
 */
export async function deleteSupportTicketScreenshot(
  uploadsDir: string,
  ref: string | null | undefined,
): Promise<void> {
  if (!ref) return;
  const match = SCREENSHOT_REF_RE.exec(ref);
  if (!match) return;
  const filename = match[1]!;
  if (filename.includes('..')) return;
  try {
    await unlink(path.join(uploadsDir, filename));
  } catch {
    // File already gone / never written — nothing to roll back.
  }
}
