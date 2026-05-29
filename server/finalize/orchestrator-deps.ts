/**
 * orchestrator-deps.ts — build a production {@link OrchestratorDeps}
 * bundle from the route-layer {@link RouteDeps} singleton.
 *
 * The orchestrator (`./orchestrator.ts`) is engine-agnostic: it takes a
 * stmts/broadcast pair plus a handful of seams (reviewer driver,
 * turn-end subscriber, fix dispatcher, push step, card lifecycle, …).
 * This module is the single production wiring site that satisfies those
 * seams from the live `RouteDeps` so the route handler can call
 * `runFinalize()` without restating each dep at every call site.
 *
 * Seams that don't yet have a production implementation are wired as
 * **throwing stubs** with explicit TODO comments. The Finalize button
 * route is the FIRST production caller of `runFinalize`; the only seam
 * truly required for the "press the button → row opens → reused logic
 * kicks in" UX is the row insert, and `runFinalize` short-circuits on a
 * pre-existing idempotent row before any seam fires. Stubs surface as
 * `infra_error` outcomes if they're ever reached — easy to spot in the
 * run row and to fix in follow-up cards.
 */
import { getDb } from '../db.js';
import { createCardLifecycle } from './card-lifecycle.js';
import { createPushAndCreatePr } from './push-and-create-pr.js';
import type { CancelSignal, FixDispatchTrigger, TurnEndSubscriber } from './fix-dispatch.js';
import type { RunReviewerOnLocalDiff } from './reviewer-dispatch.js';
import type { OrchestratorDeps } from './orchestrator.js';
import type { KanbanCardRow, RouteDeps } from '../types.js';

// ─── Stub seams ───────────────────────────────────────────────────────

/**
 * Reviewer driver stub. The real implementation needs to run the project's
 * reviewer agent against the local diff (see card on Finalize reviewer
 * wiring). Throwing here means a run that reaches the reviewer phase will
 * fail loudly with `review_failed` — the orchestrator catches and writes
 * the row's terminal state.
 *
 * TODO follow-up: implement against the reviewer-agent spawn path.
 */
const stubRunReviewer: RunReviewerOnLocalDiff = async () => {
  throw new Error(
    '[finalize] runReviewer not wired — Finalize button POST landed before the reviewer-driver seam. See follow-up card.',
  );
};

/**
 * Turn-end subscriber stub. Production wiring needs to register the
 * orchestrator's listener on the chat.ts assistant-turn-finished signal.
 * No in-process emitter exists yet (the chat path bills active seconds but
 * does not yet broadcast a typed event the dispatch loop can subscribe to).
 *
 * The stub returns a no-op unsubscribe — the fix dispatcher will then
 * never see a turn-end, and its stall watchdog will fire after the
 * configured stall window, producing a `stalled_no_response` outcome.
 * That is the correct fallback for now: it terminates the run instead of
 * deadlocking the orchestrator.
 *
 * TODO follow-up: wire to a real event emitter on chat.ts.
 */
const stubTurnEnd: TurnEndSubscriber = {
  subscribe(_sessionId: string, _onTurnEnd: () => void): () => void {
    return () => undefined;
  },
};

/**
 * Conflict-resolution dispatch stub. The rebase phase calls this when it
 * encounters a non-trivial conflict it can't auto-resolve. Production needs
 * to inject a dispatched user-message into the session and wait for the
 * session's next turn-end. Throwing here makes a real conflict surface as
 * `infra_error` instead of silently hanging.
 *
 * TODO follow-up: wire to the live dispatch + turn-end pair used by the
 * autonomous loop.
 */
async function stubDispatchAndWaitForTurnEnd(_args: {
  sessionId: string;
  cardId: string;
  body: string;
}): Promise<{ userMessagePersisted: boolean }> {
  throw new Error(
    '[finalize] dispatchAndWaitForTurnEnd not wired — Finalize button POST landed before the conflict-resolution seam.',
  );
}

// ─── Public API ────────────────────────────────────────────────────────

/**
 * Construct an {@link OrchestratorDeps} bundle from the live `RouteDeps`
 * singleton plus the (cardId, projectId) the run is anchored to.
 *
 * The card lifecycle is built per-call because it binds to the specific
 * card; everything else (stmts, broadcast, transactional, push step) is
 * derivable from `RouteDeps` and the global db handle.
 */
export function buildOrchestratorDeps(
  routeDeps: RouteDeps,
  card: KanbanCardRow,
  projectId: string,
): OrchestratorDeps {
  return {
    stmts: routeDeps.stmts,
    broadcast: routeDeps.broadcast,
    transactional: <T>(fn: () => T): T => getDb().transaction(fn)(),
    runReviewer: stubRunReviewer,
    turnEnd: stubTurnEnd,
    pushAndCreatePr: createPushAndCreatePr({ config: routeDeps.config }),
    dispatchAndWaitForTurnEnd: stubDispatchAndWaitForTurnEnd,
    cardLifecycle: createCardLifecycle(
      { stmts: routeDeps.stmts, broadcast: routeDeps.broadcast },
      { cardId: card.id, projectId },
    ),
  };
}

// Used by tests
export const __test = {
  stubRunReviewer,
  stubTurnEnd,
  stubDispatchAndWaitForTurnEnd,
};

// Re-export so the route file can compose triggers if needed.
export type { CancelSignal, FixDispatchTrigger };
