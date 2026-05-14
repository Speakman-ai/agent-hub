/**
 * Autofix dispatch wrapper.
 *
 * Wraps `dispatchReviewFeedback` from `routes/webhooks.ts` with two pieces of
 * behaviour every reviewer-feedback / CI-failure / inline-comment / conflict
 * dispatch should share but historically didn't:
 *
 *   1. **Round-counter banner.** The "3 iterations then stops" pattern we see
 *      on long PRs (e.g. #657) is almost certainly LLM context drift: the
 *      dev session sees three "Missed Review Feedback Detected" messages,
 *      decides it must have already done its job, and disengages. Stamping
 *      `Autofix round N for this PR — keep going` at the top of every
 *      dispatched message gives the agent an explicit anti-discouragement
 *      frame: each round is a fresh signal, not a redundancy.
 *
 *   2. **Structured observability log.** Before we go re-architect the
 *      reviewer-as-babysitter topology, we need to know whether the stall
 *      really is at iteration 3, whether dispatches are firing but pushes
 *      aren't materialising, etc. Every dispatch now emits a single line:
 *
 *        [Autofix] event=dispatch card=<id> kind=<kind> round=<N> \
 *          session=<sessionId|none> persisted=<bool>
 *
 *      Greppable, fixed-shape, one-line-per-event. Production logs can be
 *      mined for the dispatches-fired vs. pushes-produced ratio without
 *      adding any new metrics pipeline.
 *
 * The wrapper is intentionally thin — it does NOT change the spawn or
 * delivery semantics of `dispatchReviewFeedback`. The counter increments
 * even if `userMessagePersisted === false` (i.e. the chat queue rejected
 * the message); that's by design. Each round number represents an attempt,
 * not a successful delivery, and skipping a number would be more confusing
 * than gapless rounds with one row of `persisted=false` in the logs.
 */
import type { KanbanCardRow, Project, Stmts } from './types.js';

/** Kinds of autofix dispatches we currently wrap. Each maps to a different
 *  call site (webhook handler, autonomous poller, merge-conflict fan-out). */
export type AutofixDispatchKind =
  | 'review-changes-requested'
  | 'review-commented'
  | 'review-batch-comments'
  | 'review-missed-poll'
  | 'ci-failure'
  | 'inline-comment-poll'
  | 'conflict-resolve';

export interface AutofixDispatchResult {
  /** Session that received the message, or null when dispatch failed. */
  sessionId: string | null;
  /** True when the chat queue actually wrote the user message row. */
  userMessagePersisted: boolean;
  /** 1-indexed round number stamped into the banner for this dispatch. */
  round: number;
}

/**
 * The wrapper only needs the bump-and-return statement; everything else is
 * forwarded to the underlying dispatcher. Both stmts are declared optional
 * here so the wrapper is safe to call from tests / partial mocks that don't
 * populate the full {@link Stmts} table — a missing stmt collapses to a
 * "round 1" dispatch with no counter mutation rather than a hard crash.
 */
export interface AutofixDispatchDeps {
  stmts: Partial<Pick<Stmts, 'bumpCardAutofixDispatchCount' | 'getCardAutofixDispatchCount'>>;
}

/**
 * Forward call type matches `dispatchReviewFeedback` from `routes/webhooks.ts`.
 * Kept as a generic callable so this module doesn't import the route file
 * (which would create a cycle: routes/webhooks → autofix-dispatch → webhooks).
 */
export type ReviewFeedbackDispatcher = (
  card: KanbanCardRow,
  project: Project,
  feedbackContent: string,
) => Promise<{ sessionId: string | null; userMessagePersisted: boolean }>;

/**
 * Atomically bump the card's `autofix_dispatch_count` and return the new
 * value (1-indexed). Exported so callers that need the count without
 * dispatching (rare — debugging / tests) can use it directly.
 */
export function bumpAutofixDispatchCount(deps: AutofixDispatchDeps, cardId: string): number {
  const stmt = deps.stmts.bumpCardAutofixDispatchCount;
  if (!stmt) {
    // Partial deps (test stub / plugin entry point) — caller didn't wire the
    // counter stmt. Return round 1 so the wrapper still produces a coherent
    // banner. Production callers always go through `db.ts` and have the
    // stmt populated.
    return 1;
  }
  // RETURNING is supported by better-sqlite3 ≥ 9.0. The .get() form pulls
  // back the single row.
  const row = stmt.get(cardId) as { autofix_dispatch_count: number } | undefined;
  if (row && typeof row.autofix_dispatch_count === 'number') {
    return row.autofix_dispatch_count;
  }
  // Fallback path: the UPDATE didn't return a row (card was deleted between
  // the read and the write). Treat this as round 1 so the dispatch still
  // produces a sensible banner — the dispatch will likely fail downstream
  // anyway, but we shouldn't crash here.
  return 1;
}

/**
 * Build the per-round banner that gets prepended to every autofix-dispatched
 * message. Plain markdown so it renders in the chat transcript.
 *
 * Exported so tests can pin the wording.
 */
export function buildAutofixRoundBanner(round: number, kind: AutofixDispatchKind): string {
  const safeRound = Math.max(1, Math.floor(round));
  const kindLabel = AUTOFIX_KIND_LABELS[kind] ?? kind;
  return [
    `> 🔁 **Autofix round ${safeRound} — ${kindLabel}.**`,
    `> Multiple rounds are expected. Each round means new signal arrived (a fresh review, a new CI failure, a new comment) — that means real work remains. Do NOT decide you are "done" just because previous rounds also produced commits.`,
    `> Re-read the feedback below as if it were the first time you saw it. Address the actual issue. If you are genuinely blocked (missing credential, unclear spec, decision needed), post a PR comment explaining what you need from a human and stop — do not silently disengage.`,
  ].join('\n');
}

const AUTOFIX_KIND_LABELS: Record<AutofixDispatchKind, string> = {
  'review-changes-requested': 'changes-requested review',
  'review-commented': 'review comment',
  'review-batch-comments': 'batched inline comments',
  'review-missed-poll': 'missed-review polling fallback',
  'ci-failure': 'CI failure',
  'inline-comment-poll': 'inline-comment polling fallback',
  'conflict-resolve': 'merge conflict',
};

/**
 * Compose the round banner with the original feedback content. Banner first,
 * blank line, separator, blank line, then the original body — so the agent
 * sees the framing before the technical content.
 */
export function composeAutofixMessage(
  round: number,
  kind: AutofixDispatchKind,
  feedbackContent: string,
): string {
  const banner = buildAutofixRoundBanner(round, kind);
  return `${banner}\n\n---\n\n${feedbackContent}`;
}

/**
 * Emit the structured observability line. Stable shape — do not reorder
 * fields, downstream log mining depends on it.
 */
export function logAutofixDispatch(
  kind: AutofixDispatchKind,
  cardId: string,
  round: number,
  sessionId: string | null,
  persisted: boolean,
): void {
  console.log(
    `[Autofix] event=dispatch card=${cardId} kind=${kind} round=${round} session=${
      sessionId || 'none'
    } persisted=${persisted}`,
  );
}

/**
 * One-stop wrapper: bumps the counter, builds the banner, dispatches the
 * message, and logs the structured event. Returns the same shape the
 * underlying dispatcher does, plus the assigned round number.
 *
 * Callers swap a raw `dispatchReviewFeedback(deps, card, project, body)` for:
 *
 *   await dispatchAutofixFeedback(
 *     { stmts },
 *     card,
 *     project,
 *     'ci-failure',
 *     body,
 *     (c, p, content) => dispatchReviewFeedback(deps, c, p, content),
 *   );
 */
export async function dispatchAutofixFeedback(
  deps: AutofixDispatchDeps,
  card: KanbanCardRow,
  project: Project,
  kind: AutofixDispatchKind,
  feedbackContent: string,
  forward: ReviewFeedbackDispatcher,
): Promise<AutofixDispatchResult> {
  const round = bumpAutofixDispatchCount(deps, card.id);
  const composed = composeAutofixMessage(round, kind, feedbackContent);
  const result = await forward(card, project, composed);
  logAutofixDispatch(kind, card.id, round, result.sessionId, result.userMessagePersisted);
  return { ...result, round };
}
