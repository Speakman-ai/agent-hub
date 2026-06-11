/**
 * card-lifecycle.ts — Finalize → kanban card surface.
 *
 * The orchestrator drives a `finalize_runs` row through phases; this
 * module mirrors the user-actionable subset of those transitions onto
 * the kanban card the run is anchored to:
 *
 *   - Moves the card To Do → In Progress on trigger (idempotent).
 *   - Moves the card → Review on terminal push (`§15` post-push detach).
 *   - Posts a card comment at each user-actionable transition, so the
 *     comment timeline reads as the human-visible run history.
 *
 * **What "user-actionable" means here.** Internal phase ticks ("reviewer
 * started", "step 2 of 4 running") drive WebSocket events only — they do
 * NOT call any method on this facade. The methods exposed here are the
 * narrow set the design doc §14 calls "transitions the human in the loop
 * should see in the card thread":
 *
 *   - `onStarted` — Finalize fired, run row open. One per run.
 *   - `onRebaseClean` / `onRebaseConflictDispatched` / `onRebaseAborted` —
 *     first-iteration rebase outcome. Subsequent loop iterations stay
 *     silent on rebase to keep the comment timeline readable.
 *   - `onReviewerVerdict` — every verdict (approved / changes_requested),
 *     including when the loop re-enters and the next pass also produces
 *     one.
 *   - `onStepFailed` — every step failure that's about to be fix-dispatched.
 *   - `onPushed` — terminal success.
 *   - `onStalled` — terminal stalled-no-response (the "human walked away"
 *     branch, see card `490d6c41`).
 *   - `onTerminalFailed` — any other terminal failure (review_failed,
 *     step_failed, ci_config_invalid, timed_out, infra_error, …).
 *
 * **Comment author and shape.** Comments are posted with `author='finalize'`
 * (configurable via `opts.author`) so the comment timeline can group them
 * visually. Content is plain text, deliberately compact — the kanban UI
 * already has the live badge for state; comments are a chronological
 * audit trail.
 *
 * **Idempotency / re-trigger.** The orchestrator short-circuits with
 * `kind: 'reused'` on a re-triggered finalize against the same
 * `(project, branch, head_sha)` BEFORE this module's methods are called.
 * That short-circuit is the only reason this module does not need to
 * dedup comments itself — a re-trigger never produces a second
 * `onStarted` for the same run. New commits open a new run row and a new
 * call sequence here, which is desired.
 *
 * **Move semantics.** Moves write `column_id, position=0, updated_at=NOW()`
 * (matching `stmts.moveKanbanCard`) and emit a `kanban_update` broadcast.
 * They are no-ops when the card is already in the target column, so the
 * orchestrator can call `onStarted` unconditionally and we won't bounce
 * a card that started in In Progress. The Review move on `onPushed` only
 * fires when push terminally succeeded — failed runs leave the card
 * where it was.
 *
 * **Non-throwing contract.** Every method swallows DB / broadcast errors
 * and logs via the injected `log` sink. The orchestrator's state machine
 * is the source of truth for the run; a missing card comment is a
 * cosmetic issue, not grounds to fail the run.
 */
import { randomUUID } from 'crypto';
import type { BroadcastFn, KanbanCardRow, KanbanColumnRow, Stmts } from '../types.js';
import { runPostPushDetach, type PostPushTriggerSource } from './post-push-detach.js';

// ─── Public types ────────────────────────────────────────────────────

/**
 * Narrow facade the orchestrator uses to mirror its state machine onto
 * the kanban card surface. Every method is a single user-actionable
 * transition; no method takes a column id or comment template — the
 * impl owns the wording and the column resolution so future refactors
 * stay local.
 */
export interface CardLifecycle {
  /**
   * The finalize run has been opened. Moves the card to In Progress
   * (no-op if already there) and posts the "Finalize started" comment.
   */
  onStarted(args: { runId: string; triggerSource: 'ui_button' | 'agent_block' }): void;
  /** Rebase succeeded with no conflict dispatch. First iteration only. */
  onRebaseClean(args: { runId: string }): void;
  /** Rebase had a non-trivial conflict that was dispatched to the session. First iteration only. */
  onRebaseConflictDispatched(args: { runId: string }): void;
  /** Rebase terminally failed. */
  onRebaseAborted(args: { runId: string; detail: string }): void;
  /** Reviewer produced a verdict for this iteration. Fires once per reviewer pass. */
  onReviewerVerdict(args: { runId: string; verdict: 'approved' | 'changes_requested' }): void;
  /** A step failed and a fix-dispatch is about to be issued for it. */
  onStepFailed(args: { runId: string; stepName: string; exitCode: number }): void;
  /**
   * Review + checks passed; run is parked until the operator clicks Push.
   */
  onReadyToPush(args: { runId: string }): void;
  /**
   * Terminal push success. Delegates to the §15 post-push detach module
   * (`./post-push-detach.ts`): posts the handoff comment, then moves the
   * card to Done (when `cardDoneOnPush` is on) or Review (legacy).
   * `triggerSource` is forwarded so the comment can name
   * the autonomous trigger when appropriate. Order matters: a UI
   * subscriber that re-renders on the column-move broadcast will see the
   * comment already in place.
   */
  onPushed(args: { runId: string; prUrl: string; triggerSource: PostPushTriggerSource }): void;
  /**
   * Terminal stalled-no-response. The watchdog gave up waiting for the
   * session's next turn and the orchestrator surfaced as `stalled`. The
   * comment names the two human actions: cancel the run or re-trigger.
   */
  onStalled(args: { runId: string }): void;
  /**
   * Terminal failure other than push success or stall. Surfaces the
   * `failure_reason` on the card timeline so a failed Finalize click is
   * visible without opening the checks panel.
   */
  onTerminalFailed(args: {
    runId: string;
    status: string;
    failureReason: string;
    detail?: string;
  }): void;
}

/**
 * No-op CardLifecycle for tests and the orchestrator's default. Production
 * call-sites should always inject a real one via {@link createCardLifecycle}.
 */
export const NOOP_CARD_LIFECYCLE: CardLifecycle = {
  onStarted: () => undefined,
  onRebaseClean: () => undefined,
  onRebaseConflictDispatched: () => undefined,
  onRebaseAborted: () => undefined,
  onReviewerVerdict: () => undefined,
  onStepFailed: () => undefined,
  onReadyToPush: () => undefined,
  onPushed: (_args: { runId: string; prUrl: string; triggerSource: PostPushTriggerSource }) =>
    undefined,
  onStalled: () => undefined,
  onTerminalFailed: () => undefined,
};

export interface CardLifecycleDeps {
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

export interface CreateCardLifecycleOpts {
  /** The kanban card the finalize run is anchored to. */
  cardId: string;
  /** The project the card belongs to (used for the `kanban_update` broadcast). */
  projectId: string;
  /** Author tag on emitted comments. Defaults to `'finalize'`. */
  author?: string;
  /** Target column for the In Progress move. Defaults to `'In Progress'`. */
  inProgressColumnName?: string;
  /** Target column for the post-push detach. Defaults to `'Review'`. */
  reviewColumnName?: string;
  /**
   * When true, the post-push detach moves the card to **Done** instead of
   * Review. Wired from the `cardDoneOnPush` config flag. Defaults to false.
   */
  moveToDoneOnPush?: boolean;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build a {@link CardLifecycle} bound to a single (card, project). One
 * lifecycle per finalize run — `runId` is passed per-method so the same
 * binding could in principle serve back-to-back runs on the same card,
 * but production should construct a fresh lifecycle per run for clarity.
 */
export function createCardLifecycle(
  deps: CardLifecycleDeps,
  opts: CreateCardLifecycleOpts,
): CardLifecycle {
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? ((msg: string) => console.warn(msg));
  const author = opts.author ?? 'finalize';
  const inProgressName = opts.inProgressColumnName ?? 'In Progress';
  const reviewName = opts.reviewColumnName ?? 'Review';
  const moveToDoneOnPush = opts.moveToDoneOnPush === true;

  function postComment(content: string): void {
    try {
      deps.stmts.createKanbanCardComment.run(newId(), opts.cardId, author, content);
      deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
    } catch (err) {
      log(
        `[card-lifecycle] postComment failed for card=${opts.cardId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  function moveToColumnByName(targetName: string): void {
    try {
      const card = deps.stmts.getKanbanCard.get(opts.cardId) as KanbanCardRow | undefined;
      if (!card) {
        log(`[card-lifecycle] moveToColumnByName: card=${opts.cardId} not found`);
        return;
      }
      const cols = deps.stmts.getKanbanColumns.all(card.board_id) as KanbanColumnRow[];
      const target = cols.find((c) => c.name === targetName);
      if (!target) {
        log(
          `[card-lifecycle] moveToColumnByName: column "${targetName}" not found on ` +
            `board=${card.board_id}`,
        );
        return;
      }
      if (card.column_id === target.id) {
        // Idempotent: already in the target column, nothing to do.
        return;
      }
      // Position 0 puts the card at the top of the target column. Matches
      // `POST /board/cards/:cardId/move`'s default when no position is
      // supplied (see `routes/board.ts`), so the move surface stays
      // consistent whether a user clicked it or the orchestrator moved it.
      deps.stmts.moveKanbanCard.run(target.id, 0, opts.cardId);
      deps.broadcast({ type: 'kanban_update', projectId: opts.projectId });
      // The `card_moved` broadcast carries the human-readable column name
      // so subscribers (column-workflow runner, autonomous dispatcher) see
      // the same shape they get from the manual move endpoint. Without
      // this, those code paths would only fire on user-driven moves and
      // an orchestrator-driven In Progress / Review transition would skip
      // them. Cf. the manual move handler in `routes/board.ts`.
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
        `[card-lifecycle] moveToColumnByName(${targetName}) failed for card=${opts.cardId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    onStarted({ runId, triggerSource }) {
      // Order: move first so a UI client that subscribes to the column
      // change has the comment timeline in place once the card re-renders.
      moveToColumnByName(inProgressName);
      postComment(`Finalize started (run ${runId}) · trigger=${triggerSource}`);
    },
    onRebaseClean({ runId }) {
      postComment(`Rebase: clean (run ${runId})`);
    },
    onRebaseConflictDispatched({ runId }) {
      postComment(`Rebase: conflict dispatched to session (run ${runId})`);
    },
    onRebaseAborted({ runId, detail }) {
      postComment(`Rebase: aborted — ${detail} (run ${runId})`);
    },
    onReviewerVerdict({ runId, verdict }) {
      postComment(`Reviewer verdict: ${verdict} (run ${runId})`);
    },
    onStepFailed({ runId, stepName, exitCode }) {
      postComment(
        `Step ${stepName} failed (exit ${exitCode}) — fix dispatched to session (run ${runId})`,
      );
    },
    onPushed({ runId, prUrl, triggerSource }) {
      // §15 post-push detach lives in its own module so the wording and
      // the autonomous-trigger branch are testable in isolation. The
      // facade method stays the orchestrator's single entry point for the
      // pushed terminal so the state-machine contract is unchanged.
      runPostPushDetach(
        { stmts: deps.stmts, broadcast: deps.broadcast, newId, log },
        {
          cardId: opts.cardId,
          projectId: opts.projectId,
          prUrl,
          runId,
          triggerSource,
          author,
          reviewColumnName: reviewName,
          moveToDone: moveToDoneOnPush,
        },
      );
    },
    onStalled({ runId }) {
      postComment(`Stalled — no session response in 24hr; cancel or retrigger (run ${runId})`);
    },
    onReadyToPush({ runId }) {
      postComment(
        `Checks passed — click **Push** on the session when you are ready to open the PR (run ${runId})`,
      );
    },
    onTerminalFailed({ runId, status, failureReason, detail }) {
      const extra = detail?.trim() ? ` — ${detail.trim()}` : '';
      postComment(`Finalize failed: ${failureReason} (${status}, run ${runId})${extra}`);
    },
  };
}
