/**
 * Support ticket → kanban card field mapping.
 *
 * "Convert to card" promotes a support ticket into a To Do kanban card. This
 * module owns the pure mapping of a ticket row to the card fields (title,
 * description, priority, labels) so the transformation is unit-testable in
 * isolation from the route / DB plumbing.
 */
import type { SupportTicketRow, SupportTicketSeverity } from './types.js';

export type KanbanPriority = 'low' | 'medium' | 'high' | 'urgent';

/**
 * Severity → kanban priority. The two scales are 1:1 apart from the top of
 * the range: a `critical` ticket maps to an `urgent` card (kanban has no
 * `critical`), everything else keeps its name.
 */
export const SEVERITY_TO_PRIORITY: Record<SupportTicketSeverity, KanbanPriority> = {
  critical: 'urgent',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export function severityToPriority(severity: string): KanbanPriority {
  return SEVERITY_TO_PRIORITY[severity as SupportTicketSeverity] ?? 'medium';
}

export interface CardFieldsFromTicket {
  title: string;
  description: string;
  priority: KanbanPriority;
  labels: string;
}

/**
 * Derive the kanban card fields for a ticket.
 *
 * - **title**: the ticket subject, falling back to the first non-empty line of
 *   the body, then to a stable `Support ticket <short-id>` placeholder so a
 *   card never lands with an empty title.
 * - **description**: the full ticket body plus a footer linking back to the
 *   source support ticket (id + type/severity) so the card is traceable.
 * - **priority**: mapped from severity (see {@link SEVERITY_TO_PRIORITY}).
 * - **labels**: a comma-joined `support,<type>` tag pair so converted cards are
 *   filterable on the board.
 */
export function buildCardFieldsFromTicket(ticket: SupportTicketRow): CardFieldsFromTicket {
  const subject = (ticket.subject ?? '').trim();
  const body = (ticket.body ?? '').trim();
  const firstLine =
    body
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? '';
  const title = subject || firstLine || `Support ticket ${ticket.id.slice(0, 8)}`;

  const footer = `Converted from support ticket \`${ticket.id}\` (${ticket.type}, ${ticket.severity}).`;
  const description = body ? `${body}\n\n---\n${footer}` : footer;

  const labels = `support,${ticket.type}`;

  return {
    title,
    description,
    priority: severityToPriority(ticket.severity),
    labels,
  };
}
