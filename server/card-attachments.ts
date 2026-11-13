/**
 * Files a kanban card carries that the assigned agent should actually open:
 * the reporter screenshot and attachments of the support ticket the card was
 * converted from, plus any other `/uploads/…` file linked from the card
 * description.
 *
 * Card descriptions only hold markdown links to these files, which the CLI
 * cannot read. Returning them as chat attachments lets the chat turn stage the
 * bytes into the session worktree (`.agent-hub-images`) and tell the agent the
 * paths, the same as an image a user attaches in chat.
 */
import path from 'path';
import type { UploadedAttachment } from '../shared/types/uploads.js';
import { ensureLocalUpload } from './chat-image-staging.js';
import { listSupportTicketAttachments } from './support-ticket-attachments.js';
import { createUploadStore, type UploadStore } from './upload-store.js';
import type { AppConfig, KanbanCardRow, Stmts, SupportTicketRow } from './types.js';

const SAFE_UPLOAD_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DESCRIPTION_UPLOAD_LINK = /\]\(\s*\/uploads\/([A-Za-z0-9][A-Za-z0-9._-]*)\s*\)/g;
/** Replays are seeded as a transcript; the raw capture is noise for the agent. */
const REPLAY_UPLOAD = /^replay-.*\.json$/i;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  zip: 'application/zip',
  txt: 'text/plain',
};

function uploadNameFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /^\/uploads\/([^/?#]+)$/.exec(ref.trim());
  if (!m || !SAFE_UPLOAD_NAME.test(m[1])) return null;
  return m[1];
}

function guessMime(filename: string): string {
  const ext = path.extname(filename).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

interface Candidate {
  filename: string;
  originalName: string;
  contentType: string;
}

/** Pure: which upload files does this card reference? Ordered, deduped. */
export function collectCardUploadCandidates(
  stmts: Pick<Stmts, 'getSupportTicket'>,
  card: Pick<KanbanCardRow, 'description' | 'support_ticket_id' | 'customer_report_id'>,
  projectId: string,
): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (filename: string | null, originalName?: string, contentType?: string) => {
    if (!filename || seen.has(filename) || REPLAY_UPLOAD.test(filename)) return;
    seen.add(filename);
    out.push({
      filename,
      originalName: originalName || filename,
      contentType: contentType || guessMime(filename),
    });
  };

  const ticketId = card.support_ticket_id ?? card.customer_report_id;
  if (ticketId) {
    const ticket = stmts.getSupportTicket.get(ticketId) as SupportTicketRow | undefined;
    if (ticket && ticket.project_id === projectId) {
      add(uploadNameFromRef(ticket.screenshot_ref), 'screenshot');
      for (const a of listSupportTicketAttachments(ticket.id)) {
        add(uploadNameFromRef(a.ref), a.filename, a.mime);
      }
    }
  }

  for (const m of (card.description ?? '').matchAll(DESCRIPTION_UPLOAD_LINK)) {
    add(m[1]);
  }
  return out;
}

/**
 * The card's files as chat attachments. Each file is hydrated into the local
 * uploads dir first; one that cannot be found is skipped with a log line,
 * because the chat turn fails outright when staging an attachment throws and
 * a missing screenshot must not block the assignment.
 */
export async function loadCardUploadAttachments(
  deps: {
    stmts: Pick<Stmts, 'getSupportTicket'>;
    config: AppConfig;
    uploadStore?: UploadStore;
  },
  card: Pick<KanbanCardRow, 'id' | 'description' | 'support_ticket_id' | 'customer_report_id'>,
  projectId: string,
): Promise<UploadedAttachment[]> {
  let candidates: Candidate[];
  try {
    candidates = collectCardUploadCandidates(deps.stmts, card, projectId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[Card Attachments] Failed to list files for card ${card.id}: ${message}`);
    return [];
  }
  if (candidates.length === 0) return [];

  const uploadsDir = deps.config.uploadsDir;
  const store = deps.uploadStore ?? createUploadStore(deps.config, uploadsDir);
  const out: UploadedAttachment[] = [];
  for (const c of candidates) {
    try {
      await ensureLocalUpload(store, uploadsDir, c.filename);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Card Attachments] Skipping ${c.filename} for card ${card.id}: ${message}`);
      continue;
    }
    out.push({
      id: path.parse(c.filename).name,
      filename: c.filename,
      originalName: c.originalName,
      contentType: c.contentType,
      url: `/uploads/${c.filename}`,
    });
  }
  return out;
}
