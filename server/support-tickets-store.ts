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
  SupportTicketReleaseState,
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

export const SUPPORT_TICKET_RELEASE_STATES = [
  'fixed_pending_release',
  'released_to_prod',
  'customer_notified',
] as const satisfies readonly SupportTicketReleaseState[];

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

export function deriveSupportTicketReleaseState(
  ticket: Pick<SupportTicketRow, 'fixed_at' | 'released_to_prod_at' | 'customer_notified_at'>,
): SupportTicketReleaseState | null {
  if (ticket.customer_notified_at) return 'customer_notified';
  if (ticket.released_to_prod_at) return 'released_to_prod';
  if (ticket.fixed_at) return 'fixed_pending_release';
  return null;
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
 * Change a ticket's severity. Returns the updated row, or null if the ticket
 * doesn't exist. Throws on an invalid severity. Severity drives queue ordering
 * and the priority a converted kanban card inherits, so operators need to be
 * able to correct an intake that came in over- or under-stated.
 */
export function updateSupportTicketSeverity(
  id: string,
  severity: SupportTicketSeverity,
): SupportTicketRow | null {
  if (!isSeverity(severity)) {
    throw new Error(`severity must be one of: ${SUPPORT_TICKET_SEVERITIES.join(', ')}`);
  }
  if (!getSupportTicket(id)) return null;
  getStmts().updateSupportTicketSeverity.run(severity, id);
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
 * Human-facing identity of the kanban card a ticket was converted into or
 * linked to. The ticket row only stores an opaque `converted_card_id`, which
 * matches nothing an operator can see on the board — cards are identified
 * there by `#short_id` and title. Responses carry this summary so the support
 * UI can name the card and link straight to it.
 */
export interface ConvertedCardSummary {
  id: string;
  short_id: number | null;
  title: string;
  column_name: string | null;
}

const CONVERTED_CARD_SUMMARY_SELECT = `SELECT c.id AS id, c.short_id AS short_id, c.title AS title, col.name AS column_name
     FROM kanban_cards c
     LEFT JOIN kanban_columns col ON col.id = c.column_id`;

/** Resolve a card id to its board-facing identity, or null if it's gone. */
export function getConvertedCardSummary(
  cardId: string | null | undefined,
): ConvertedCardSummary | null {
  if (!cardId) return null;
  const row = getDb().prepare(`${CONVERTED_CARD_SUMMARY_SELECT} WHERE c.id = ?`).get(cardId) as
    | ConvertedCardSummary
    | undefined;
  return row ?? null;
}

/**
 * Batch sibling of {@link getConvertedCardSummary}, keyed by card id. List
 * responses resolve every converted card in one round trip instead of one
 * query per ticket. Ids missing from the map are cards that no longer exist.
 */
export function getConvertedCardSummaries(
  cardIds: Array<string | null | undefined>,
): Map<string, ConvertedCardSummary> {
  const out = new Map<string, ConvertedCardSummary>();
  const ids = uniqueStrings(cardIds);
  if (!ids.length) return out;
  // SQLite's default host-parameter ceiling is 999, so chunk rather than
  // letting a large converted-ticket page blow the statement apart.
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = getDb()
      .prepare(`${CONVERTED_CARD_SUMMARY_SELECT} WHERE c.id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk) as ConvertedCardSummary[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

function uniqueStrings(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
        .map((v) => v.trim()),
    ),
  ];
}

function rowsByIds(ids: string[]): SupportTicketRow[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return getDb()
    .prepare(`SELECT * FROM support_tickets WHERE id IN (${placeholders}) ORDER BY rowid ASC`)
    .all(...ids) as SupportTicketRow[];
}

export function supportTicketIdsForCards(projectId: string, cardIds: string[]): string[] {
  if (!cardIds.length) return [];
  const placeholders = cardIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT st.id
         FROM kanban_cards c
         JOIN kanban_boards b
           ON b.id = c.board_id
          AND b.project_id = ?
         JOIN support_tickets st
           ON st.project_id = ?
          AND (
            st.id = COALESCE(c.support_ticket_id, c.customer_report_id)
            OR st.converted_card_id = c.id
          )
        WHERE c.id IN (${placeholders})`,
    )
    .all(projectId, projectId, ...cardIds) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

export function markSupportTicketsFixedPendingReleaseForCard(
  projectId: string,
  cardId: string,
): SupportTicketRow[] {
  const ticketIds = supportTicketIdsForCards(projectId, uniqueStrings([cardId]));
  if (!ticketIds.length) return [];
  const placeholders = ticketIds.map(() => '?').join(',');
  getDb()
    .prepare(
      `UPDATE support_tickets
          SET fixed_at = COALESCE(fixed_at, datetime('now')),
              updated_at = datetime('now')
        WHERE id IN (${placeholders})
          AND fixed_at IS NULL`,
    )
    .run(...ticketIds);
  return rowsByIds(ticketIds);
}

export function markSupportTicketsReleasedToProd(input: {
  projectId: string;
  deploymentId: string;
  cardIds?: string[];
  supportTicketIds?: string[];
}): SupportTicketRow[] {
  const directIds = uniqueStrings(input.supportTicketIds ?? []);
  const directTicketIds = directIds.length
    ? (
        getDb()
          .prepare(
            `SELECT id
               FROM support_tickets
              WHERE project_id = ?
                AND id IN (${directIds.map(() => '?').join(',')})`,
          )
          .all(input.projectId, ...directIds) as Array<{ id: string }>
      ).map((row) => row.id)
    : [];
  const ids = uniqueStrings([
    ...directTicketIds,
    ...supportTicketIdsForCards(input.projectId, uniqueStrings(input.cardIds ?? [])),
  ]);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  getDb()
    .prepare(
      `UPDATE support_tickets
          SET fixed_at = COALESCE(fixed_at, datetime('now')),
              released_to_prod_at = COALESCE(released_to_prod_at, datetime('now')),
              release_deployment_id = COALESCE(release_deployment_id, ?),
              updated_at = datetime('now')
        WHERE id IN (${placeholders})`,
    )
    .run(input.deploymentId, ...ids);
  return rowsByIds(ids);
}

export function markSupportTicketsCustomerNotified(ids: string[]): SupportTicketRow[] {
  const ticketIds = uniqueStrings(ids);
  if (!ticketIds.length) return [];
  const placeholders = ticketIds.map(() => '?').join(',');
  getDb()
    .prepare(
      `UPDATE support_tickets
          SET fixed_at = COALESCE(fixed_at, datetime('now')),
              released_to_prod_at = COALESCE(released_to_prod_at, datetime('now')),
              customer_notified_at = COALESCE(customer_notified_at, datetime('now')),
              updated_at = datetime('now')
        WHERE id IN (${placeholders})`,
    )
    .run(...ticketIds);
  return rowsByIds(ticketIds);
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
