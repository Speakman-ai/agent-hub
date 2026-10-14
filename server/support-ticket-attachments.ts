/**
 * Files attached to a support ticket: extra screenshots, logs, HAR captures,
 * screen recordings, PDFs, zipped bundles.
 *
 * Bytes land in the shared upload store under `/uploads/support-attachment-*`
 * and the metadata (original filename, sniffed type, size) lives in
 * `support_ticket_attachments`. The reporter screenshot keeps its own
 * `screenshot_ref` column; this module covers everything else.
 *
 * `/uploads` is served same-origin and the public bug-report intake can write
 * here without auth, so the accepted types are a closed allowlist decided by
 * the bytes, never by the declared content type or the filename alone. In
 * particular nothing that a browser would execute (HTML, SVG, JS) can be stored.
 */
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { getDb } from './db.js';
import { sniffImageMime } from './support-ticket-screenshot.js';
import type { UploadStore } from './upload-store.js';
import type { SupportTicketAttachmentRow } from './types.js';

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_TICKET = 20;
export const MAX_ATTACHMENT_FILENAME_LENGTH = 200;

/** Extensions whose bytes are accepted as plain UTF-8 text. */
const TEXT_EXTENSIONS = new Set(['txt', 'log', 'json', 'har', 'csv', 'md']);

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'application/zip': 'zip',
  // Every text upload is stored as .txt so the static handler serves it as
  // text/plain whatever the original extension was.
  'text/plain': 'txt',
};

export const SUPPORT_TICKET_ATTACHMENT_TYPES_HINT =
  'images (png, jpeg, webp, gif), PDF, video (mp4, mov, webm), zip, or text (txt, log, json, har, csv, md)';

export class AttachmentValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'AttachmentValidationError';
    this.status = status;
  }
}

function sniffBinaryMime(buf: Buffer): string | null {
  const image = sniffImageMime(buf);
  if (image) return image;
  if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
  // ISO base media (mp4 / mov): "ftyp" box at offset 4.
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    return buf.toString('latin1', 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4';
  }
  // EBML header (webm / matroska).
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm';
  }
  // Zip local-file header, or the end-of-central-directory record of an empty zip.
  if (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06))
  ) {
    return 'application/zip';
  }
  return null;
}

function isPlainUtf8Text(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function extensionOf(filename: string): string {
  return path.extname(filename).replace(/^\./, '').toLowerCase();
}

/**
 * Normalize an uploader-supplied filename for display: basename only, control
 * characters stripped, length capped. Falls back to `file` when nothing usable
 * is left.
 */
export function sanitizeAttachmentFilename(raw: string | null | undefined): string {
  // Strip both separator styles so a Windows path doesn't survive on POSIX.
  const base = String(raw ?? '')
    .split(/[\\/]/)
    .pop()!
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  if (!base || base === '.' || base === '..') return 'file';
  if (base.length <= MAX_ATTACHMENT_FILENAME_LENGTH) return base;
  const ext = path.extname(base);
  const keepExt = ext.length > 0 && ext.length <= 16;
  const stem = base.slice(0, MAX_ATTACHMENT_FILENAME_LENGTH - (keepExt ? ext.length : 0));
  return keepExt ? `${stem}${ext}` : stem;
}

/**
 * Decide whether `buffer` may be stored as a ticket attachment. Returns the
 * canonical mime + stored extension, or throws {@link AttachmentValidationError}
 * (413 for oversize, 400 otherwise).
 */
export function validateAttachment(
  buffer: Buffer,
  filename: string,
): { mime: string; ext: string } {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new AttachmentValidationError('file is empty');
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    const mb = (MAX_ATTACHMENT_BYTES / (1024 * 1024)).toFixed(0);
    throw new AttachmentValidationError(`file exceeds the ${mb} MB limit`, 413);
  }
  const binary = sniffBinaryMime(buffer);
  if (binary) return { mime: binary, ext: EXT_BY_MIME[binary]! };
  if (TEXT_EXTENSIONS.has(extensionOf(filename)) && isPlainUtf8Text(buffer)) {
    return { mime: 'text/plain', ext: 'txt' };
  }
  throw new AttachmentValidationError(
    `unsupported file type; allowed: ${SUPPORT_TICKET_ATTACHMENT_TYPES_HINT}`,
  );
}

/** Only the exact shape this module writes, so deletes can't reach other uploads. */
const ATTACHMENT_REF_RE = /^\/uploads\/(support-attachment-[A-Za-z0-9-]+\.[a-z0-9]+)$/;

async function deleteAttachmentBytes(uploadStore: UploadStore, ref: string): Promise<void> {
  const match = ATTACHMENT_REF_RE.exec(ref);
  if (!match) return;
  try {
    await uploadStore.delete(match[1]!);
  } catch {
    // Best effort: a missing object must not fail the request that removed the row.
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

export function listSupportTicketAttachments(ticketId: string): SupportTicketAttachmentRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM support_ticket_attachments
       WHERE support_ticket_id = ?
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(ticketId) as SupportTicketAttachmentRow[];
}

/** Batched lookup for list serialization (one query per 500 tickets). */
export function listSupportTicketAttachmentsByTicket(
  ticketIds: string[],
): Map<string, SupportTicketAttachmentRow[]> {
  const out = new Map<string, SupportTicketAttachmentRow[]>();
  const ids = [...new Set(ticketIds)];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = getDb()
      .prepare(
        `SELECT * FROM support_ticket_attachments
         WHERE support_ticket_id IN (${chunk.map(() => '?').join(',')})
         ORDER BY created_at ASC, rowid ASC`,
      )
      .all(...chunk) as SupportTicketAttachmentRow[];
    for (const row of rows) {
      const list = out.get(row.support_ticket_id);
      if (list) list.push(row);
      else out.set(row.support_ticket_id, [row]);
    }
  }
  return out;
}

export function getSupportTicketAttachment(id: string): SupportTicketAttachmentRow | null {
  return (
    (getDb().prepare('SELECT * FROM support_ticket_attachments WHERE id = ?').get(id) as
      | SupportTicketAttachmentRow
      | undefined) ?? null
  );
}

export function countSupportTicketAttachments(ticketId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM support_ticket_attachments WHERE support_ticket_id = ?')
    .get(ticketId) as { n: number };
  return row.n;
}

/**
 * Validate, store, and record one attachment. The count cap is checked and the
 * row inserted in one transaction so concurrent uploads can't overshoot it; the
 * stored bytes are removed again if the insert is refused.
 */
export async function addSupportTicketAttachment(
  uploadStore: UploadStore,
  input: { ticketId: string; buffer: Buffer; filename: string; createdBy?: string | null },
): Promise<SupportTicketAttachmentRow> {
  const filename = sanitizeAttachmentFilename(input.filename);
  const { mime, ext } = validateAttachment(input.buffer, filename);
  if (countSupportTicketAttachments(input.ticketId) >= MAX_ATTACHMENTS_PER_TICKET) {
    throw new AttachmentValidationError(
      `a ticket can have at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`,
      409,
    );
  }

  const id = uuidv4();
  const storedName = `support-attachment-${id}.${ext}`;
  const ref = `/uploads/${storedName}`;
  await uploadStore.put(storedName, input.buffer, mime);

  const db = getDb();
  try {
    return db.transaction(() => {
      if (countSupportTicketAttachments(input.ticketId) >= MAX_ATTACHMENTS_PER_TICKET) {
        throw new AttachmentValidationError(
          `a ticket can have at most ${MAX_ATTACHMENTS_PER_TICKET} attachments`,
          409,
        );
      }
      return db
        .prepare(
          `INSERT INTO support_ticket_attachments
             (id, support_ticket_id, ref, filename, mime, size_bytes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           RETURNING *`,
        )
        .get(
          id,
          input.ticketId,
          ref,
          filename,
          mime,
          input.buffer.length,
          input.createdBy ?? null,
        ) as SupportTicketAttachmentRow;
    })();
  } catch (err) {
    await deleteAttachmentBytes(uploadStore, ref);
    throw err;
  }
}

/**
 * Remove one attachment row and its bytes. `keepBytes` leaves the stored file in
 * place (a converted card's description still links to it).
 */
export async function removeSupportTicketAttachment(
  uploadStore: UploadStore,
  attachment: SupportTicketAttachmentRow,
  opts: { keepBytes?: boolean } = {},
): Promise<void> {
  getDb().prepare('DELETE FROM support_ticket_attachments WHERE id = ?').run(attachment.id);
  if (!opts.keepBytes) await deleteAttachmentBytes(uploadStore, attachment.ref);
}

/**
 * Delete the stored bytes for attachments whose rows are already gone (the
 * ticket was hard-deleted and the rows cascaded). `keep` filters out refs that
 * must survive.
 */
export async function deleteSupportTicketAttachmentFiles(
  uploadStore: UploadStore,
  attachments: SupportTicketAttachmentRow[],
  keep: (ref: string) => boolean = () => false,
): Promise<void> {
  for (const a of attachments) {
    if (!keep(a.ref)) await deleteAttachmentBytes(uploadStore, a.ref);
  }
}

/** Markdown lines carrying attachments onto a card (images inline, others as links). */
export function attachmentMarkdownLines(attachments: SupportTicketAttachmentRow[]): string {
  if (!attachments.length) return '';
  const escape = (s: string) => s.replace(/([\\[\]])/g, '\\$1');
  const lines = attachments.map((a) =>
    a.mime.startsWith('image/')
      ? `- ![${escape(a.filename)}](${a.ref})`
      : `- [${escape(a.filename)}](${a.ref})`,
  );
  return `\n\n**Attachments:**\n${lines.join('\n')}`;
}
