/**
 * post-push-detach.ts — Finalize Code Changes, §15 post-push detach.
 *
 * Runs at the `pushed` terminal of a finalize run. Once the orchestrator
 * has pushed the branch and opened the PR on GitHub, Agent Hub's job on
 * the change is done: the developer (or downstream reviewer) owns it from
 * here. This module is the explicit hand-off point onto the kanban card:
 *
 *   1. Posts a comment that reads as "finalized, here is the PR, you own
 *      it now". For runs triggered by the autonomous dispatcher (the
 *      `agent_block` trigger source), the comment also names the trigger
 *      so a human scanning the card thread can tell at a glance whether
 *      the run was kicked off manually or by autonomous mode.
 *
 *   2. Moves the card → existing **Review** column. No new column is
 *      introduced — the design (§15) deliberately keeps the board schema
 *      stable; the comment carries the handoff semantics.
 *
 * The card stays in Review until the GitHub PR merges. The PR-close
 * webhook handler (`server/routes/webhooks.ts`, `handleWebhookPrClosed`)
 * moves the card to Done on merge. The webhook does NOT auto-dispatch the
 * reviewer on the resulting GitHub PR — the provenance check in
 * `./provenance.ts` (`classifyPr` returns `internal` via registry hit on
 * the `finalize_runs.pr_url` row) lets the webhook recognise our own PRs
 * and skip the redundant review pass. Together, the comment + the
 * provenance check + the merge-close handler form the complete §15 loop.
 *
 * **Why a dedicated module.** This terminal is the single moment the
 * finalize run "leaves" Agent Hub and lives on GitHub. Keeping it in its
 * own file (rather than inline in `card-lifecycle.ts` or the orchestrator)
 * makes the wording, the order of side effects, and the autonomous-trigger
 * branch testable in isolation — and makes future changes to the handoff
 * message a one-file patch.
 *
 * **Order of side effects.** Comment first, then move. A UI subscriber
 * that re-renders the card on the column-move broadcast will already see
 * the comment in the thread by the time the move event lands. The order
 * matches `card-lifecycle.onStarted` so the user-visible card timeline
 * stays consistent (move + comment both appear, comment-before-move).
 *
 * **Non-throwing contract.** Every side effect is wrapped in a try/catch
 * and logged via the injected `log` sink. The orchestrator already wrote
 * the terminal `pushed` status and the `pr_url` to `finalize_runs` before
 * calling us — a missed card comment or a missed column move is cosmetic,
 * not grounds to retroactively fail a successful push.
 *
 * **Idempotency.** Moving a card that's already in Review is a no-op.
 * Re-running the detach on the same card (the orchestrator should never,
 * but a future caller might) emits a second comment but does not move the
 * card again. We do NOT dedup comments — the human-facing intent is
 * "every detach call leaves a timeline entry", and the orchestrator owns
 * the "don't call us twice" invariant.
 *
 * See wiki: `finalize-code-changes-architecture-v0` (§15).
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, KanbanCardRow, KanbanColumnRow, Stmts } from '../types.js';

// ─── Public types ────────────────────────────────────────────────────

/**
 * Trigger source of the finalize run. Mirrors
 * `OrchestratorOptions.triggerSource` so the orchestrator can pass it
 * straight through without translation.
 *
 *   - `'ui_button'` — a human clicked Finalize in the UI.
 *   - `'agent_block'` — the autonomous dispatcher fired the run.
 *
 * The comment wording adopts a small suffix for `agent_block` so the
 * card timeline records the trigger provenance in human-readable form
 * (the kanban UI does not surface `finalize_runs.trigger_source`
 * directly today, so the comment is the only place a human-in-the-loop
 * sees the difference).
 */
export type PostPushTriggerSource = 'ui_button' | 'agent_block';

export interface PostPushDetachDeps {
  stmts: Pick<
    Stmts,
    'getKanbanCard' | 'getKanbanColumns' | 'moveKanbanCard' | 'createKanbanCardComment'
  >;
  broadcast: BroadcastFn;
  /** Optional UUID minter for comment ids. Defaults to `crypto.randomUUID`. */
  newId?: () => string;
  /** Optional log sink. Defaults to `console.warn`. */
  log?: (msg: string) => void;
}

export interface PostPushDetachOpts {
  /** The kanban card the finalize run is anchored to. */
  cardId: string;
  /** The project the card belongs to (used for the `kanban_update` broadcast). */
  projectId: string;
  /** The PR URL that was just pushed to GitHub. */
  prUrl: string;
  /** The finalize run id (for the comment trailer). */
  runId: string;
  /** Trigger source of the finalize run. Drives the autonomous suffix. */
  triggerSource: PostPushTriggerSource;
  /** Author tag on the emitted comment. Defaults to `'finalize'`. */
  author?: string;
  /** Target column for the move. Defaults to `'Review'`. */
  reviewColumnName?: string;
}

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Format the post-push handoff comment.
 *
 * Pure / synchronous / no side effects — exported so tests can pin the
 * wording without standing up the surrounding deps. Body shape:
 *
 *   line 1: handoff statement (always)
 *   line 2: PR URL (always)
 *   line 3: autonomous-trigger note (only when `triggerSource === 'agent_block'`)
 *   line N: `(run <runId>)` trailer (always)
 *
 * The wording matches the §15 acceptance spec; any change here is a
 * user-visible change to the card timeline and should be reviewed by
 * whoever owns the finalize architecture doc.
 */
export function formatPostPushComment(args: {
  prUrl: string;
  runId: string;
  triggerSource: PostPushTriggerSource;
}): string {
  const lines: string[] = [
    'Finalized. PR is on GitHub, owned by the developer from here.',
    args.prUrl,
  ];
  if (args.triggerSource === 'agent_block') {
    lines.push('(triggered by autonomous agent)');
  }
  lines.push(`(run ${args.runId})`);
  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Run the §15 post-push detach for one finalize run.
 *
 * Side effects, in order:
 *
 *   1. Insert a `kanban_card_comments` row with the formatted comment
 *      and broadcast `kanban_update`.
 *   2. If the card is not already in the Review column, move it there
 *      via `moveKanbanCard.run(reviewColId, 0, cardId)` and broadcast
 *      both `kanban_update` and `card_moved` (matching `card-lifecycle`'s
 *      move semantics so column-workflow subscribers see the same shape
 *      as a manual move).
 *
 * Both side effects are wrapped in try/catch and swallow any error into
 * the `log` sink (see the JSDoc on the module for rationale). Callers
 * MUST treat this function as fire-and-forget for the orchestrator's
 * terminal contract — the `pushed` status is already persisted by the
 * time we are called.
 */
export function runPostPushDetach(deps: PostPushDetachDeps, opts: PostPushDetachOpts): void {
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const author = opts.author ?? 'finalize';
  const reviewName = opts.reviewColumnName ?? 'Review';

  const content = formatPostPushComment({
    prUrl: opts.prUrl,
    runId: opts.runId,
    triggerSource: opts.triggerSource,
  });

  // ── 1) post the handoff comment ────────────────────────────────────
  try {
    deps.stmts.createKanbanCardComment.run(newId(), opts.cardId, author, content);
    deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
  } catch (err) {
    log(
      `[post-push-detach] postComment failed for card=${opts.cardId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // ── 2) move card → Review (idempotent) ─────────────────────────────
  try {
    const card = deps.stmts.getKanbanCard.get(opts.cardId) as KanbanCardRow | undefined;
    if (!card) {
      log(`[post-push-detach] move: card=${opts.cardId} not found`);
      return;
    }
    const cols = deps.stmts.getKanbanColumns.all(card.board_id) as KanbanColumnRow[];
    const target = cols.find((c) => c.name === reviewName);
    if (!target) {
      log(`[post-push-detach] move: column "${reviewName}" not found on board=${card.board_id}`);
      return;
    }
    if (card.column_id === target.id) {
      // Idempotent: already in Review, nothing to do.
      return;
    }
    deps.stmts.moveKanbanCard.run(target.id, 0, opts.cardId);
    deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
    deps.broadcast({
      type: 'card_moved',
      projectId: opts.projectId,
      cardId: opts.cardId,
      cardTitle: card.title,
      columnName: target.name,
      assignee: card.assignee,
      prUrl: card.pr_url,
      sessionId: card.session_id || undefined,
    });
  } catch (err) {
    log(
      `[post-push-detach] move failed for card=${opts.cardId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
