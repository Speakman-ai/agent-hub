/**
 * Support tickets store.
 *
 * Customer support requests live in their OWN project-scoped queue, separate
 * from the kanban board (see `support_tickets` in db.ts). The status lifecycle
 * — new → investigating → converted / closed — is distinct from kanban
 * columns, and the list API orders by severity (most severe first) so the most
 * urgent requests surface at the top of the queue.
 *
 * This module owns all reads/writes against the table; routes and any
 * background investigators call into these helpers rather than touching
 * prepared statements directly.
 */
import { v4 as uuidv4 } from 'uuid';
import { getStmts } from './db.js';
import type {
  SupportTicketRow,
  SupportTicketType,
  SupportTicketSeverity,
  SupportTicketStatus,
} from './types.js';

export const SUPPORT_TICKET_TYPES = [
  'bug',
  'question',
  'feature_request',
  'incident',
  'other',
] as const satisfies readonly SupportTicketType[];

export const SUPPORT_TICKET_SEVERITIES = [
  'critical',
  'high',
  'medium',
  'low',
] as const satisfies readonly SupportTicketSeverity[];

export const SUPPORT_TICKET_STATUSES = [
  'new',
  'investigating',
  'converted',
  'closed',
] as const satisfies readonly SupportTicketStatus[];

function isType(v: unknown): v is SupportTicketType {
  return typeof v === 'string' && (SUPPORT_TICKET_TYPES as readonly string[]).includes(v);
}
function isSeverity(v: unknown): v is SupportTicketSeverity {
  return typeof v === 'string' && (SUPPORT_TICKET_SEVERITIES as readonly string[]).includes(v);
}
function isStatus(v: unknown): v is SupportTicketStatus {
  return typeof v === 'string' && (SUPPORT_TICKET_STATUSES as readonly string[]).includes(v);
}

export interface CreateSupportTicketInput {
  projectId: string;
  body: string;
  type?: SupportTicketType;
  severity?: SupportTicketSeverity;
  subject?: string;
  reporter?: string | null;
  replayRef?: string | null;
  screenshotRef?: string | null;
}

/**
 * Create a support ticket. `type` defaults to 'other', `severity` to 'medium',
 * status always starts at 'new'. Throws on an empty body or an invalid
 * type/severity so callers get a clear 400 instead of a CHECK-constraint
 * SqliteError.
 */
export function createSupportTicket(input: CreateSupportTicketInput): SupportTicketRow {
  const { projectId } = input;
  if (!projectId) throw new Error('projectId is required');
  const body = (input.body ?? '').trim();
  if (!body) throw new Error('body is required');

  const type = input.type ?? 'other';
  const severity = input.severity ?? 'medium';
  if (!isType(type)) {
    throw new Error(`type must be one of: ${SUPPORT_TICKET_TYPES.join(', ')}`);
  }
  if (!isSeverity(severity)) {
    throw new Error(`severity must be one of: ${SUPPORT_TICKET_SEVERITIES.join(', ')}`);
  }

  const id = uuidv4();
  getStmts().createSupportTicket.run(
    id,
    projectId,
    type,
    severity,
    'new',
    input.subject?.trim() ?? '',
    body,
    input.reporter ?? null,
    input.replayRef ?? null,
    input.screenshotRef ?? null,
  );
  return getSupportTicket(id)!;
}

/** Fetch a single ticket, or null if it doesn't exist. */
export function getSupportTicket(id: string): SupportTicketRow | null {
  return (getStmts().getSupportTicket.get(id) as SupportTicketRow | undefined) ?? null;
}

/**
 * List a project's tickets ordered by severity (critical → low) then newest.
 * Pass `status` to filter to a single lifecycle state.
 */
export function listSupportTickets(
  projectId: string,
  opts: { status?: SupportTicketStatus } = {},
): SupportTicketRow[] {
  const stmts = getStmts();
  if (opts.status) {
    if (!isStatus(opts.status)) {
      throw new Error(`status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}`);
    }
    return stmts.listSupportTicketsByProjectAndStatus.all(
      projectId,
      opts.status,
    ) as SupportTicketRow[];
  }
  return stmts.listSupportTicketsByProject.all(projectId) as SupportTicketRow[];
}

/**
 * Move a ticket to a new lifecycle status. Returns the updated row, or null if
 * the ticket doesn't exist. Throws on an invalid status.
 */
export function updateSupportTicketStatus(
  id: string,
  status: SupportTicketStatus,
): SupportTicketRow | null {
  if (!isStatus(status)) {
    throw new Error(`status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}`);
  }
  if (!getSupportTicket(id)) return null;
  getStmts().updateSupportTicketStatus.run(status, id);
  return getSupportTicket(id);
}

/**
 * Record the result of an AI investigation and stamp `ai_investigated_at`.
 * Returns null if the ticket doesn't exist.
 *
 * The update is partial: a field left `undefined` preserves the ticket's
 * current value, while an explicit `null` clears it. This lets a caller set
 * the summary without wiping a previously-stored investigation (and vice
 * versa).
 */
export function recordSupportTicketInvestigation(
  id: string,
  investigation: { summary?: string | null; details?: string | null },
): SupportTicketRow | null {
  const existing = getSupportTicket(id);
  if (!existing) return null;
  const summary = investigation.summary !== undefined ? investigation.summary : existing.ai_summary;
  const details =
    investigation.details !== undefined ? investigation.details : existing.ai_investigation;
  getStmts().updateSupportTicketInvestigation.run(summary, details, id);
  return getSupportTicket(id);
}

/**
 * Replace a ticket's free-text body. Returns the updated row, or null if the
 * ticket doesn't exist. Used by the bug-report intake to finalize the body once
 * the replay ref has been accepted (or cleared) by the attribution guard, so a
 * rejected ref never lingers in the operator-visible body.
 */
export function setSupportTicketBody(id: string, body: string): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().setSupportTicketBody.run(body, id);
  return getSupportTicket(id);
}

/** Attach (or clear, with null) a session-replay reference. */
export function setSupportTicketReplayRef(
  id: string,
  replayRef: string | null,
): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().setSupportTicketReplayRef.run(replayRef, id);
  return getSupportTicket(id);
}

/** Attach (or clear, with null) a screenshot reference. */
export function setSupportTicketScreenshotRef(
  id: string,
  screenshotRef: string | null,
): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().setSupportTicketScreenshotRef.run(screenshotRef, id);
  return getSupportTicket(id);
}

/**
 * Promote a ticket to a kanban card: records the card id and flips status to
 * 'converted'. Returns null if the ticket doesn't exist.
 */
export function convertSupportTicketToCard(id: string, cardId: string): SupportTicketRow | null {
  if (!cardId) throw new Error('cardId is required');
  if (!getSupportTicket(id)) return null;
  getStmts().convertSupportTicketToCard.run(cardId, id);
  return getSupportTicket(id);
}

/**
 * Mark a ticket read (stamp `read_at` if it was unread). Returns the updated
 * row, or null if the ticket doesn't exist. Idempotent: re-reading an
 * already-read ticket is a no-op that returns the unchanged row.
 */
export function markSupportTicketRead(id: string): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().markSupportTicketRead.run(id);
  return getSupportTicket(id);
}

/**
 * Mark a ticket unread (clear `read_at`). Returns the updated row, or null if
 * the ticket doesn't exist. Idempotent on an already-unread ticket.
 */
export function markSupportTicketUnread(id: string): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().markSupportTicketUnread.run(id);
  return getSupportTicket(id);
}

/**
 * Mark every unread ticket in a project read. Returns the number of rows that
 * flipped from unread to read.
 */
export function markAllSupportTicketsRead(projectId: string): number {
  return getStmts().markAllSupportTicketsRead.run(projectId).changes;
}

/** Count a project's unread tickets (read_at IS NULL). */
export function countUnreadSupportTickets(projectId: string): number {
  const row = getStmts().countUnreadSupportTickets.get(projectId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Delete a ticket. Returns true if a row was removed. */
export function deleteSupportTicket(id: string): boolean {
  const result = getStmts().deleteSupportTicket.run(id);
  return result.changes > 0;
}
