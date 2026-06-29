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
import { getStmts, getDb } from './db.js';
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
  'duplicate',
  'wont_do',
] as const satisfies readonly SupportTicketStatus[];

/**
 * The "open" lifecycle states — the queue's default view. Everything else
 * (`converted`, `closed`, `duplicate`, `wont_do`) is terminal and hidden until
 * the operator explicitly filters for it, so resolved tickets don't clutter the
 * working queue but are never destroyed.
 */
export const SUPPORT_TICKET_OPEN_STATUSES = [
  'new',
  'investigating',
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
  reporterEmail?: string | null;
  replayRef?: string | null;
  screenshotRef?: string | null;
}

const SIMPLE_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeReporterEmail(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    throw new Error('reporter_email must be a valid email address');
  }
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  if (email.length > 254 || !SIMPLE_EMAIL_RE.test(email)) {
    throw new Error('reporter_email must be a valid email address');
  }
  return email;
}

export function maskReporterEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const [local = '', domain = ''] = email.split('@');
  if (!local || !domain) return '***';
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${'*'.repeat(Math.max(3, local.length - visible.length))}@${domain}`;
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
  const reporterEmail = normalizeReporterEmail(input.reporterEmail);

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
    reporterEmail,
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
 *
 * - `statuses` — restrict to these lifecycle states (the queue uses this to
 *   show only "open" tickets by default and to reveal terminal states on
 *   demand). Omit/empty to return every status.
 * - `type` — restrict to a single request type (bug / feature_request / …).
 *
 * The query is built dynamically because the optional filters multiply out to
 * several combinations; the severity ordering matches the prepared statements.
 */
export function listSupportTickets(
  projectId: string,
  opts: { statuses?: SupportTicketStatus[]; type?: SupportTicketType } = {},
): SupportTicketRow[] {
  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [projectId];

  const statuses = opts.statuses ?? [];
  if (statuses.length) {
    for (const s of statuses) {
      if (!isStatus(s)) {
        throw new Error(`status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}`);
      }
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (opts.type !== undefined) {
    if (!isType(opts.type)) {
      throw new Error(`type must be one of: ${SUPPORT_TICKET_TYPES.join(', ')}`);
    }
    where.push('type = ?');
    params.push(opts.type);
  }

  const sql = `SELECT * FROM support_tickets WHERE ${where.join(' AND ')} ORDER BY ${SEVERITY_ORDER_SQL}`;
  return getDb()
    .prepare(sql)
    .all(...params) as SupportTicketRow[];
}

/**
 * Severity rank used by every list query: SQLite has no native enum ordering,
 * so a CASE expression maps the severity enum to a sort rank (critical first).
 * Ties break newest-first. Kept here as the single source of truth so the
 * project-scoped and cross-project queries stay in lock-step.
 */
const SEVERITY_ORDER_SQL = `CASE severity
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4 END ASC,
    created_at DESC,
    rowid DESC`;

/**
 * List support tickets across ALL projects, ordered by severity (critical →
 * low) then newest. Powers the cross-project support overview. Pass `projectId`
 * to scope to a single project, `status` to filter to one lifecycle state,
 * and/or `unread: true` to keep only tickets a human hasn't viewed yet
 * (`read_at IS NULL`) — all optional and compose. The query is built
 * dynamically (rather than via a prepared statement) because the optional
 * filters multiply out; the severity ordering is identical to the per-project
 * queries.
 */
export function listAllSupportTickets(
  opts: {
    projectId?: string;
    statuses?: SupportTicketStatus[];
    type?: SupportTicketType;
    unread?: boolean;
  } = {},
): SupportTicketRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.projectId) {
    where.push('project_id = ?');
    params.push(opts.projectId);
  }
  const statuses = opts.statuses ?? [];
  if (statuses.length) {
    for (const s of statuses) {
      if (!isStatus(s)) {
        throw new Error(`status must be one of: ${SUPPORT_TICKET_STATUSES.join(', ')}`);
      }
    }
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (opts.unread) {
    where.push('read_at IS NULL');
  }
  if (opts.type !== undefined) {
    if (!isType(opts.type)) {
      throw new Error(`type must be one of: ${SUPPORT_TICKET_TYPES.join(', ')}`);
    }
    where.push('type = ?');
    params.push(opts.type);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM support_tickets ${whereClause} ORDER BY ${SEVERITY_ORDER_SQL}`;
  return getDb()
    .prepare(sql)
    .all(...params) as SupportTicketRow[];
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
 * Reclassify a ticket's request type. Returns the updated row, or null if the
 * ticket doesn't exist. Throws on an invalid type.
 */
export function updateSupportTicketType(
  id: string,
  type: SupportTicketType,
): SupportTicketRow | null {
  if (!isType(type)) {
    throw new Error(`type must be one of: ${SUPPORT_TICKET_TYPES.join(', ')}`);
  }
  if (!getSupportTicket(id)) return null;
  getStmts().updateSupportTicketType.run(type, id);
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

/**
 * Set (or clear, with null) the operator-supplied "won't do" reason. Returns
 * the updated row, or null if the ticket doesn't exist. The route pairs this
 * with a status transition: a non-empty reason when moving to `wont_do`, and a
 * `null` clear when moving to any other status.
 */
export function setSupportTicketWontDoReason(
  id: string,
  reason: string | null,
): SupportTicketRow | null {
  if (!getSupportTicket(id)) return null;
  getStmts().setSupportTicketWontDoReason.run(reason, id);
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
