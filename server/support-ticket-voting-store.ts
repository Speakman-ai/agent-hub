/**
 * Feature-request voting store.
 *
 * Persistence for `support_ticket_votes` and `support_ticket_comments`. One
 * row per (ticket, voter_key) with value in {+1, -1}; upsert rewrites the
 * value, DELETE retracts. Score is SUM(value). Comments are anonymous
 * (optional display_name, no user id); operators hide via hidden_at.
 *
 * `voter_key` is an already-derived opaque token. Email hashing and
 * browser-token minting belong to the vote-endpoint layer, not here, so this
 * table never sees raw PII.
 */
import { v4 as uuidv4 } from 'uuid';
import { getStmts } from './db.js';
import { getSupportTicket } from './support-tickets-store.js';
import type {
  SupportTicketCommentRow,
  SupportTicketCommentSource,
  SupportTicketVoteRow,
  SupportTicketVoteValue,
} from './types.js';

/** Matches MAX_ASSIGNMENT_COMMENT_LEN on the board comment surface. */
export const SUPPORT_TICKET_COMMENT_MAX_LEN = 4000;

export const SUPPORT_TICKET_COMMENT_SOURCES = [
  'hub',
  'external',
] as const satisfies readonly SupportTicketCommentSource[];

export interface SupportTicketVoteAggregate {
  score: number;
  upvotes: number;
  downvotes: number;
  myVote: SupportTicketVoteValue | null;
}

export interface UpsertSupportTicketVoteInput {
  supportTicketId: string;
  voterKey: string;
  value: SupportTicketVoteValue;
}

export interface AddSupportTicketCommentInput {
  supportTicketId: string;
  body: string;
  displayName?: string | null;
  source: SupportTicketCommentSource;
}

function isVoteValue(v: unknown): v is SupportTicketVoteValue {
  return v === 1 || v === -1;
}

function isCommentSource(v: unknown): v is SupportTicketCommentSource {
  return typeof v === 'string' && (SUPPORT_TICKET_COMMENT_SOURCES as readonly string[]).includes(v);
}

function requireTicket(id: string): void {
  if (!getSupportTicket(id)) {
    throw new Error(`support ticket not found: ${id}`);
  }
}

function normalizeVoterKey(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new Error('voter_key is required');
  }
  const voterKey = raw.trim();
  if (!voterKey) {
    throw new Error('voter_key is required');
  }
  return voterKey;
}

function asVoteRow(row: unknown): SupportTicketVoteRow {
  return row as SupportTicketVoteRow;
}

function asCommentRow(row: unknown): SupportTicketCommentRow {
  return row as SupportTicketCommentRow;
}

/**
 * Insert or rewrite a vote for (ticket, voter_key). Same value is idempotent;
 * the opposite value flips the existing row in place.
 */
export function upsertSupportTicketVote(input: UpsertSupportTicketVoteInput): SupportTicketVoteRow {
  const voterKey = normalizeVoterKey(input.voterKey);
  if (!isVoteValue(input.value)) {
    throw new Error('value must be 1 or -1');
  }
  requireTicket(input.supportTicketId);
  const row = getStmts().upsertSupportTicketVote.get(
    uuidv4(),
    input.supportTicketId,
    voterKey,
    input.value,
  );
  if (!row) throw new Error('failed to persist vote');
  return asVoteRow(row);
}

/** Delete the (ticket, voter_key) row. Returns true if a row was removed. */
export function retractSupportTicketVote(supportTicketId: string, voterKey: string): boolean {
  const key = normalizeVoterKey(voterKey);
  const result = getStmts().deleteSupportTicketVote.run(supportTicketId, key);
  return result.changes > 0;
}

export function getSupportTicketVote(
  supportTicketId: string,
  voterKey: string,
): SupportTicketVoteRow | null {
  const key = normalizeVoterKey(voterKey);
  const row = getStmts().getSupportTicketVote.get(supportTicketId, key);
  return row ? asVoteRow(row) : null;
}

/**
 * Aggregate votes for a ticket. `myVote` is the caller's current value, or
 * null when they have not voted / no voter_key was supplied.
 */
export function getSupportTicketVoteAggregate(
  supportTicketId: string,
  voterKey?: string | null,
): SupportTicketVoteAggregate {
  const totals = getStmts().aggregateSupportTicketVotes.get(supportTicketId) as
    | { score: number; upvotes: number; downvotes: number }
    | undefined;
  let myVote: SupportTicketVoteValue | null = null;
  if (typeof voterKey === 'string' && voterKey.trim()) {
    const mine = getSupportTicketVote(supportTicketId, voterKey);
    myVote = mine?.value ?? null;
  }
  return {
    score: totals?.score ?? 0,
    upvotes: totals?.upvotes ?? 0,
    downvotes: totals?.downvotes ?? 0,
    myVote,
  };
}

export function addSupportTicketComment(
  input: AddSupportTicketCommentInput,
): SupportTicketCommentRow {
  requireTicket(input.supportTicketId);
  const body = (input.body ?? '').trim();
  if (!body) {
    throw new Error('body is required');
  }
  if (body.length > SUPPORT_TICKET_COMMENT_MAX_LEN) {
    throw new Error(`body must be ${SUPPORT_TICKET_COMMENT_MAX_LEN} characters or fewer`);
  }
  if (!isCommentSource(input.source)) {
    throw new Error(`source must be one of: ${SUPPORT_TICKET_COMMENT_SOURCES.join(', ')}`);
  }
  const displayName = input.displayName?.trim() || null;
  const row = getStmts().insertSupportTicketComment.get(
    uuidv4(),
    input.supportTicketId,
    body,
    displayName,
    input.source,
  );
  if (!row) throw new Error('failed to persist comment');
  return asCommentRow(row);
}

export function listSupportTicketComments(
  supportTicketId: string,
  opts?: { includeHidden?: boolean },
): SupportTicketCommentRow[] {
  const stmt = opts?.includeHidden
    ? getStmts().listSupportTicketCommentsIncludingHidden
    : getStmts().listSupportTicketComments;
  return stmt.all(supportTicketId) as SupportTicketCommentRow[];
}

/** Soft-delete. Returns the hidden row, or null if missing / already hidden. */
export function hideSupportTicketComment(id: string): SupportTicketCommentRow | null {
  const row = getStmts().hideSupportTicketComment.get(id);
  return row ? asCommentRow(row) : null;
}

export function getSupportTicketComment(id: string): SupportTicketCommentRow | null {
  const row = getStmts().getSupportTicketComment.get(id);
  return row ? asCommentRow(row) : null;
}

/** Count of non-hidden comments on a ticket. */
export function countSupportTicketComments(supportTicketId: string): number {
  const row = getStmts().countSupportTicketComments.get(supportTicketId) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
