/**
 * Done-state contract guard for the board card-move endpoint.
 *
 * The Kanban Done-state contract (documented in CLAUDE.md and the wiki page
 * `kanban-done-state-contract-when-a-card-may-move-to-done`) says a card may
 * enter a Done column only if ONE of these holds:
 *
 *   (a) Full scope shipped — every acceptance criterion was delivered. The
 *       card title carries NO `[Spec]` / `[Partial]` prefix; moving it to Done
 *       is itself the "full scope" attestation.
 *   (b) Partial / spec only — the title IS prefixed `[Spec]` or `[Partial]`
 *       AND a comment on the card lists the follow-up card IDs that cover the
 *       gap. Both halves are required: the prefix makes the gap visible
 *       at-a-glance; the IDs make the remaining work findable.
 *
 * Before this guard the contract was documentation-only. That let an unmet
 * acceptance criterion be silently relabeled `[Partial]` and moved to Done
 * with no follow-up ever filed — exactly the failure this module prevents.
 * The guard rejects case (b) when the follow-up card IDs are missing, so a
 * partial can no longer be parked in Done without a tracked follow-up.
 *
 * Scope: ONLY `POST /board/cards/:cardId/move` consults this, alongside the
 * sibling premature-Done guard. Platform Done-writers (post-push detach,
 * card-on-merge, `<agenthub:close-card>` auto-close, epic-spec completion)
 * call `moveKanbanCard` directly and are unaffected — extending the same
 * predicate to those paths as a non-blocking flag is tracked as a follow-up.
 *
 * Like the premature-Done guard, `force: true` bypasses it: the break-glass
 * `x-api-key` is an all-orgs-Owner credential, so this is a guardrail that
 * corrects the default flow and fails loudly, not a hard privilege boundary.
 */
import { isColumnDone } from './kanban-blockers.js';
import type { KanbanCardCommentRow, KanbanCardRow } from './types.js';

export const DONE_STATE_CONTRACT_ERROR = 'done_state_contract_violation';

export const DONE_STATE_CONTRACT_MESSAGE =
  'This card is titled [Spec]/[Partial], so its acceptance criteria were not ' +
  'fully met. The Done-state contract requires a comment listing the follow-up ' +
  'card IDs (a card UUID or a #short-id) that cover the gap before it can move ' +
  'to Done. Either deliver the remaining scope and drop the prefix, or add a ' +
  'comment referencing the follow-up card(s). Pass "force": true to override ' +
  '(operator escape hatch).';

/** Leading `[Spec]` / `[Partial]` prefix, case-insensitive, tolerant of whitespace. */
const PARTIAL_SPEC_PREFIX = /^\s*\[\s*(spec|partial)\s*\]/i;

/** RFC-4122-ish UUID anywhere in a string (case-insensitive). */
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** `#123` short-id token (word-boundary so `#1` in prose still counts). */
const SHORT_ID_PATTERN = /#(\d+)\b/g;

/**
 * True when the title marks the card as partial/spec-only (contract path b).
 * A card WITHOUT this prefix is treated as a full-scope attestation (path a).
 */
export function hasPartialOrSpecPrefix(title: string | null | undefined): boolean {
  return PARTIAL_SPEC_PREFIX.test(title ?? '');
}

export interface FollowupReferenceArgs {
  card: Pick<KanbanCardRow, 'id' | 'short_id'>;
  comments: Pick<KanbanCardCommentRow, 'content'>[];
}

/**
 * True when at least one comment references a follow-up card — a card UUID or
 * a `#short-id` — other than this card itself. Self-references (the card's own
 * id / short-id) never count, so quoting your own id can't satisfy the guard.
 */
export function commentsReferenceFollowupCards(args: FollowupReferenceArgs): boolean {
  const selfId = (args.card.id ?? '').toLowerCase();
  const selfShortId = args.card.short_id == null ? null : String(args.card.short_id);

  for (const comment of args.comments) {
    const text = comment.content ?? '';

    for (const match of text.matchAll(UUID_PATTERN)) {
      if (match[0].toLowerCase() !== selfId) return true;
    }
    for (const match of text.matchAll(SHORT_ID_PATTERN)) {
      if (match[1] !== selfShortId) return true;
    }
  }
  return false;
}

export interface DoneStateContractMoveArgs {
  card: Pick<KanbanCardRow, 'id' | 'short_id' | 'title'>;
  /** All comments currently on the card. */
  comments: Pick<KanbanCardCommentRow, 'content'>[];
  /** Name of the column the move targets. */
  targetColumnName: string;
  /** Explicit override from the request body — skips the guard entirely. */
  force?: boolean;
}

/**
 * True when the move must be rejected as a Done-state-contract violation:
 * a `[Spec]`/`[Partial]`-titled card entering a Done column without any
 * follow-up card IDs referenced in its comments.
 */
export function blocksDoneStateContractMove(args: DoneStateContractMoveArgs): boolean {
  if (args.force === true) return false;
  if (!isColumnDone(args.targetColumnName)) return false;
  // Path (a): no prefix = full-scope attestation, always allowed.
  if (!hasPartialOrSpecPrefix(args.card.title)) return false;
  // Path (b): prefixed, so require follow-up card IDs in the comments.
  return !commentsReferenceFollowupCards({ card: args.card, comments: args.comments });
}
