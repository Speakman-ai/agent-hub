import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { resolveVisibilityCaller } from './project-visibility-middleware.js';
import {
  deriveSupportTicketReleaseState,
  getConvertedCardSummaries,
  getConvertedCardSummary,
  maskReporterEmail,
  type ConvertedCardSummary,
} from './support-tickets-store.js';
import {
  listReleaseNotificationOutboxBySupportTicket,
  releaseNotificationHistoryItem,
  type ReleaseNotificationHistoryItem,
} from './release-notification-outbox.js';
import type {
  SupportTicketCommentRow,
  SupportTicketCommentSource,
  SupportTicketReleaseState,
  SupportTicketRow,
  SupportTicketSeverity,
  SupportTicketStatus,
  SupportTicketType,
} from './types.js';
import type {
  SupportTicketVotingListRow,
  SupportTicketVotingTally,
} from './support-ticket-voting-store.js';

export type SupportTicketResponse = SupportTicketRow & {
  reporter_email_masked: boolean;
  release_state: SupportTicketReleaseState | null;
  release_notifications?: ReleaseNotificationHistoryItem[];
  /** Board-facing identity of `converted_card_id`, or null when unset/deleted. */
  converted_card: ConvertedCardSummary | null;
};

export interface LinkedSupportTicketMetadata {
  id: string;
  project_id: string;
  type: SupportTicketRow['type'];
  severity: SupportTicketRow['severity'];
  status: SupportTicketRow['status'];
  subject: string;
  reporter: string | null;
  reporter_email: string | null;
  reporter_email_masked: boolean;
  converted_card_id: string | null;
  release_state: SupportTicketReleaseState | null;
  fixed_at: string | null;
  released_to_prod_at: string | null;
  release_deployment_id: string | null;
  customer_notified_at: string | null;
  created_at: string;
  updated_at: string;
}

export function canReadReporterEmail(req: Request): boolean {
  const caller = resolveVisibilityCaller(req);
  return Boolean(caller.localBypass || caller.role === 'Owner' || caller.role === 'Admin');
}

/**
 * True for a non-interactive API-key request — the Survey-Tracker-facing
 * class. Both key shapes count: the global break-glass X-API-Key
 * (`authViaApiKey`, no Hub user) AND a per-user `ahub_*` key
 * (`authViaUserApiKey`, which DOES carry an `authUserId`). The card lets
 * Survey Tracker present either, so classifying only the keyless global path
 * as external would leak the full ticket (reporter_email, AI investigation,
 * replay refs, release fields) to a per-user-key caller.
 *
 * Interactive operators — a JWT/cookie session, or the single-tenant local
 * bundle (`authLocalOrgBypass`) — are never external and keep the full shape.
 * Distinguishing operator SESSIONS from API-key REQUESTS is the invariant;
 * whether the key maps to a user is irrelevant.
 */
export function isExternalSupportCaller(req: Request): boolean {
  const areq = req as AuthenticatedRequest;
  if (areq.authLocalOrgBypass) return false;
  return Boolean(areq.authViaApiKey || areq.authViaUserApiKey);
}

export function commentSourceForRequest(req: Request): SupportTicketCommentSource {
  return isExternalSupportCaller(req) ? 'external' : 'hub';
}

export type SupportTicketCommentResponse = {
  id: string;
  support_ticket_id: string;
  body: string;
  display_name: string | null;
  source: SupportTicketCommentSource;
  created_at: string;
  hidden_at?: string | null;
};

/** Hub-auth keeps `source` + `hidden_at`. External projection drops `hidden_at`. */
export function serializeSupportTicketComment(
  req: Request,
  comment: SupportTicketCommentRow,
): SupportTicketCommentResponse {
  if (isExternalSupportCaller(req)) {
    return {
      id: comment.id,
      support_ticket_id: comment.support_ticket_id,
      body: comment.body,
      display_name: comment.display_name,
      source: comment.source,
      created_at: comment.created_at,
    };
  }
  return {
    id: comment.id,
    support_ticket_id: comment.support_ticket_id,
    body: comment.body,
    display_name: comment.display_name,
    source: comment.source,
    hidden_at: comment.hidden_at,
    created_at: comment.created_at,
  };
}

export function serializeSupportTicket(
  ticket: SupportTicketRow,
  opts: {
    canReadReporterEmail: boolean;
    releaseNotifications?: ReleaseNotificationHistoryItem[];
    /**
     * Pre-resolved card summary (see {@link serializeSupportTickets}). Pass it
     * to skip the per-ticket lookup; omit it entirely for single-ticket reads.
     * `null` means "already resolved, and the card is gone".
     */
    convertedCard?: ConvertedCardSummary | null;
  },
): SupportTicketResponse {
  const hasEmail = Boolean(ticket.reporter_email);
  const response: SupportTicketResponse = {
    ...ticket,
    reporter_email: opts.canReadReporterEmail
      ? ticket.reporter_email
      : maskReporterEmail(ticket.reporter_email),
    reporter_email_masked: hasEmail && !opts.canReadReporterEmail,
    release_state: deriveSupportTicketReleaseState(ticket),
    converted_card:
      opts.convertedCard !== undefined
        ? opts.convertedCard
        : getConvertedCardSummary(ticket.converted_card_id),
  };
  if (opts.releaseNotifications) {
    response.release_notifications = opts.releaseNotifications;
  }
  return response;
}

export function serializeSupportTicketForRequest(
  req: Request,
  ticket: SupportTicketRow,
  opts: { includeReleaseNotifications?: boolean } = {},
): SupportTicketResponse {
  const releaseNotifications = opts.includeReleaseNotifications
    ? listReleaseNotificationOutboxBySupportTicket(ticket.id).map(releaseNotificationHistoryItem)
    : undefined;
  return serializeSupportTicket(ticket, {
    canReadReporterEmail: canReadReporterEmail(req),
    releaseNotifications,
  });
}

/**
 * Serialize a whole list of tickets.
 *
 * Never map `serializeSupportTicket` over a list directly: that resolves the
 * converted card one query per ticket (an N+1 on any converted-status page).
 * This batches the card lookup into a single round trip first.
 */
export function serializeSupportTickets(
  tickets: SupportTicketRow[],
  opts: { canReadReporterEmail: boolean },
): SupportTicketResponse[] {
  const summaries = getConvertedCardSummaries(tickets.map((t) => t.converted_card_id));
  return tickets.map((ticket) =>
    serializeSupportTicket(ticket, {
      canReadReporterEmail: opts.canReadReporterEmail,
      convertedCard: ticket.converted_card_id
        ? (summaries.get(ticket.converted_card_id) ?? null)
        : null,
    }),
  );
}

/** Request-scoped {@link serializeSupportTickets} — resolves email visibility once. */
export function serializeSupportTicketsForRequest(
  req: Request,
  tickets: SupportTicketRow[],
): SupportTicketResponse[] {
  return serializeSupportTickets(tickets, { canReadReporterEmail: canReadReporterEmail(req) });
}

export function serializeSupportTicketForBroadcast(
  ticket: SupportTicketRow,
): SupportTicketResponse {
  return serializeSupportTicket(ticket, { canReadReporterEmail: false });
}

export function linkedSupportTicketMetadata(
  ticket: SupportTicketRow,
  opts: { canReadReporterEmail: boolean },
): LinkedSupportTicketMetadata {
  const serialized = serializeSupportTicket(ticket, opts);
  return {
    id: serialized.id,
    project_id: serialized.project_id,
    type: serialized.type,
    severity: serialized.severity,
    status: serialized.status,
    subject: serialized.subject,
    reporter: serialized.reporter,
    reporter_email: serialized.reporter_email,
    reporter_email_masked: serialized.reporter_email_masked,
    converted_card_id: serialized.converted_card_id,
    release_state: serialized.release_state,
    fixed_at: serialized.fixed_at,
    released_to_prod_at: serialized.released_to_prod_at,
    release_deployment_id: serialized.release_deployment_id,
    customer_notified_at: serialized.customer_notified_at,
    created_at: serialized.created_at,
    updated_at: serialized.updated_at,
  };
}

export function defaultReporterEmail(req: Request): string | null {
  const authUser = (req as AuthenticatedRequest).authUser;
  return typeof authUser === 'string' && authUser.includes('@') ? authUser : null;
}

/**
 * Hub-facing voting item: the full ticket serialization plus the vote/comment
 * tally. Interactive operators (JWT / local bypass) see this shape.
 */
export type SupportTicketVotingHubItem = SupportTicketResponse & {
  voting: SupportTicketVotingTally;
};

/**
 * External (Survey-Tracker) voting item. An allowlist projection matching the
 * public contract exactly: `id` (required to cast subsequent vote/comment
 * calls) plus subject/body/type/severity/status and the vote+comment tally
 * (`voting` = score/upvotes/downvotes/myVote/comment_count). Nothing else —
 * no project_id, no timestamps. Every operator-only field (ai_summary,
 * ai_investigation, ai_investigated_at, reporter_email, replay_ref,
 * wont_do_reason, release ids, converted card, screenshot, read/resolved
 * timestamps) is stripped by construction, so a column added to
 * SupportTicketRow later never leaks to the public surface. Widening this
 * shape is a deliberate public-contract change, not an incidental one.
 */
export interface SupportTicketVotingExternalItem {
  id: string;
  type: SupportTicketType;
  severity: SupportTicketSeverity;
  status: SupportTicketStatus;
  subject: string;
  body: string;
  voting: SupportTicketVotingTally;
}

export type SupportTicketVotingItemResponse =
  | SupportTicketVotingHubItem
  | SupportTicketVotingExternalItem;

function projectVotingItemExternal(
  row: SupportTicketVotingListRow,
): SupportTicketVotingExternalItem {
  const { ticket, voting } = row;
  return {
    id: ticket.id,
    type: ticket.type,
    severity: ticket.severity,
    status: ticket.status,
    subject: ticket.subject,
    body: ticket.body,
    voting,
  };
}

/**
 * Serialize the score-ranked voting feed for the calling identity. External
 * API-key-only callers (Survey Tracker) get the safe projection above; every
 * Hub caller gets the full ticket shape with the tally attached (converted-card
 * lookups batched by {@link serializeSupportTicketsForRequest}).
 */
export function serializeVotingListForRequest(
  req: Request,
  rows: SupportTicketVotingListRow[],
): SupportTicketVotingItemResponse[] {
  if (isExternalSupportCaller(req)) {
    return rows.map(projectVotingItemExternal);
  }
  const tickets = serializeSupportTicketsForRequest(
    req,
    rows.map((r) => r.ticket),
  );
  return tickets.map((ticket, i) => ({ ...ticket, voting: rows[i]!.voting }));
}
