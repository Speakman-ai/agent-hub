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
 *   2. Moves the card → **Review** (the default) or straight to **Done**
 *      (only when the `cardDoneOnPush` config flag is explicitly enabled).
 *      No new column is introduced — the design (§15) deliberately keeps
 *      the board schema stable; the comment carries the handoff semantics.
 *
 * By default (`cardDoneOnPush=false`), "Done means merged, not pushed": the
 * card stays in Review until the PR merges, and the merge handler moves it to
 * Done. With `cardDoneOnPush` enabled, "pushed = shipped": the card lands in
 * Done the moment the branch reaches GitHub. In the disabled (default) case
 * the legacy GitHub PR-close webhook handler
 * (`server/routes/webhooks.ts`, `handleWebhookPrClosed`) moves it to Done on
 * merge (that handler is a no-op when the card is already Done). The webhook
 * does NOT auto-dispatch the
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
 * **Order of side effects.** The move DB write runs first so the comment
 * headline can assert only a CONFIRMED transition — the Done variant
 * ("card moved to Done") would otherwise lie if the card were missing, the
 * board had no Done column, or `moveKanbanCard` threw. The BROADCAST order,
 * however, stays comment-first: the comment's `kanban_update` is emitted
 * before the move's `kanban_update` / `card_moved`, so a UI subscriber that
 * re-renders the card on the column-move broadcast already sees the comment
 * in the thread by the time the move event lands.
 *
 * **Honest headline.** When the move cannot be confirmed (`unresolved`), the
 * comment falls back to the non-assertive handoff line ("Finalized. PR is on
 * GitHub…") rather than claiming a Done transition that did not happen.
 *
 * **Non-throwing contract.** Every side effect is wrapped in a try/catch
 * and logged via the injected `log` sink. The orchestrator already wrote
 * the terminal `pushed` status and the `pr_url` to `finalize_runs` before
 * calling us — a missed card comment or a missed column move is cosmetic,
 * not grounds to retroactively fail a successful push.
 *
 * **Idempotency.** Moving a card that's already in the target column is a
 * no-op write (but the headline still truthfully reflects the target state).
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
import { pickDoneColumn } from '../card-auto-close.js';

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
/**
 * `git_push` is included for type-compatibility with `FinalizeRunRow`
 * (push-CI rows reuse the table) but can never reach the post-push
 * detach path — push-CI runs have no push step and no real card.
 */
export type PostPushTriggerSource = 'ui_button' | 'agent_block' | 'git_push' | 'pr_push';

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
  /** Target column for the Review move. Defaults to `'Review'`. */
  reviewColumnName?: string;
  /**
   * When true, move the card to the board's **Done** column (resolved via
   * {@link pickDoneColumn}) instead of Review. Driven by the
   * `cardDoneOnPush` config flag: operators who treat "pushed = shipped"
   * want the card marked Done the moment the branch lands on GitHub, rather
   * than parking it in Review until the PR-merge webhook. Defaults to false
   * (legacy §15 push → Review flow).
   */
  moveToDone?: boolean;
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
  /** When true, the card was moved to Done rather than Review. */
  movedToDone?: boolean;
}): string {
  const headline = args.movedToDone
    ? 'Finalized and pushed to GitHub — card moved to Done.'
    : 'Finalized. PR is on GitHub, owned by the developer from here.';
  const lines: string[] = [headline, args.prUrl];
  if (args.triggerSource === 'agent_block') {
    lines.push('(triggered by autonomous agent)');
  }
  lines.push(`(run ${args.runId})`);
  return lines.join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Outcome of the card move, resolved BEFORE the comment is written so the
 * comment headline can only ever assert a transition that actually happened.
 *
 *   - `moved`     — the DB write succeeded; a column change occurred.
 *   - `already`   — the card was already in the target column (no write,
 *                   but the card IS in the target state, so an assertive
 *                   "moved to Done" headline is still truthful).
 *   - `unresolved`— card missing, target column missing, or the move write
 *                   threw. The card's column did NOT reach the target, so the
 *                   headline must stay non-assertive.
 */
type MoveOutcome =
  | { kind: 'moved'; card: KanbanCardRow; target: KanbanColumnRow }
  | { kind: 'already' }
  | { kind: 'unresolved' };

/**
 * Resolve the target column and execute the move DB write, returning a typed
 * outcome. No broadcasts here — the caller orders those so the comment's
 * `kanban_update` still lands before the move's `kanban_update` / `card_moved`
 * (the comment-before-move broadcast contract; see the module JSDoc). The
 * write happens first only so the headline can reflect a CONFIRMED state.
 */
function resolveAndExecuteMove(
  deps: PostPushDetachDeps,
  opts: PostPushDetachOpts,
  log: (msg: string) => void,
): MoveOutcome {
  const moveToDone = opts.moveToDone === true;
  const reviewName = opts.reviewColumnName ?? 'Review';
  try {
    const card = deps.stmts.getKanbanCard.get(opts.cardId) as KanbanCardRow | undefined;
    if (!card) {
      log(`[post-push-detach] move: card=${opts.cardId} not found`);
      return { kind: 'unresolved' };
    }
    const cols = deps.stmts.getKanbanColumns.all(card.board_id) as KanbanColumnRow[];
    // When `moveToDone` is set (cardDoneOnPush config), resolve the Done
    // column the same way the `<agenthub:close-card>` path does
    // (exact "done" → contains "done" → rightmost). Otherwise fall back to
    // the legacy exact-name Review match.
    const target = moveToDone ? pickDoneColumn(cols) : cols.find((c) => c.name === reviewName);
    if (!target) {
      const detail = moveToDone
        ? `Done column not found on board=${card.board_id}`
        : `column "${reviewName}" not found on board=${card.board_id}`;
      log(`[post-push-detach] move: ${detail}`);
      return { kind: 'unresolved' };
    }
    if (card.column_id === target.id) {
      // Idempotent: already in the target column, nothing to write.
      return { kind: 'already' };
    }
    deps.stmts.moveKanbanCard.run(target.id, 0, opts.cardId);
    return { kind: 'moved', card, target };
  } catch (err) {
    log(
      `[post-push-detach] move failed for card=${opts.cardId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: 'unresolved' };
  }
}

/**
 * Run the §15 post-push detach for one finalize run.
 *
 * Side effects, in order:
 *
 *   1. Resolve the target column (Done when `moveToDone`, else Review) and
 *      execute the move DB write, capturing a {@link MoveOutcome}. No
 *      broadcast yet.
 *   2. Insert a `kanban_card_comments` row whose headline reflects the
 *      CONFIRMED outcome — the "card moved to Done" assertion is only used
 *      when the card actually reached Done (`moved` / `already`). When the
 *      move is `unresolved` (card missing, no target column, write threw) the
 *      headline falls back to the non-assertive handoff line so the card
 *      thread never claims a transition that did not happen. Broadcast
 *      `kanban_update`.
 *   3. If a column change actually occurred (`moved`), broadcast
 *      `kanban_update` + `card_moved` (matching `card-lifecycle`'s move
 *      semantics so column-workflow subscribers see the same shape as a
 *      manual move).
 *
 * The DB move write runs before the comment so the headline can be honest,
 * but the BROADCAST order stays comment-first (step 2 before step 3) to
 * preserve the contract that a UI subscriber re-rendering on the `card_moved`
 * event already has the comment in the thread.
 *
 * Every side effect is wrapped in try/catch and swallows any error into the
 * `log` sink (see the module JSDoc for rationale). Callers MUST treat this
 * function as fire-and-forget for the orchestrator's terminal contract — the
 * `pushed` status is already persisted by the time we are called.
 */
export function runPostPushDetach(deps: PostPushDetachDeps, opts: PostPushDetachOpts): void {
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const author = opts.author ?? 'finalize';
  const moveToDone = opts.moveToDone === true;

  // ── 1) Resolve + execute the move FIRST (no broadcast) so the headline
  //       can assert only a confirmed transition. ──
  const move = resolveAndExecuteMove(deps, opts, log);
  const reachedTarget = move.kind === 'moved' || move.kind === 'already';

  // ── 2) Post the handoff comment with an honest headline, then broadcast. ─
  const content = formatPostPushComment({
    prUrl: opts.prUrl,
    runId: opts.runId,
    triggerSource: opts.triggerSource,
    // Only assert "moved to Done" when the card actually reached Done.
    movedToDone: moveToDone && reachedTarget,
  });
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

  // ── 3) Broadcast the move only when a column change actually occurred. ──
  //       Guarded: a throwing broadcast must not escape this fire-and-forget
  //       function — the move write and `pushed` status are already
  //       persisted, so a dropped notification is cosmetic.
  if (move.kind === 'moved') {
    try {
      deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
      deps.broadcast({
        type: 'card_moved',
        projectId: opts.projectId,
        cardId: opts.cardId,
        cardTitle: move.card.title,
        columnName: move.target.name,
        assignee: move.card.assignee,
        prUrl: move.card.pr_url,
        sessionId: move.card.session_id || undefined,
      });
    } catch (err) {
      log(
        `[post-push-detach] move broadcast failed for card=${opts.cardId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
}
