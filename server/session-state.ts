import type { Stmts } from './types.js';
import { lookupFinalizeStatusForSession } from './session-checkpoint-rewind.js';
import { isColumnDone } from './kanban-blockers.js';
import {
  SESSION_STATES,
  DEFAULT_SESSION_STATE,
  isSessionState,
  resolveSessionState,
  type SessionState,
  type SessionStateSignals,
} from '../shared/utils/sessionState.js';

// Re-export the shared pure model so server callers have a single import site.
export {
  SESSION_STATES,
  DEFAULT_SESSION_STATE,
  isSessionState,
  resolveSessionState,
  type SessionState,
  type SessionStateSignals,
};

/** Best-effort: is there a `running` active_tasks row for this session? */
function lookupHasActiveTask(stmts: Stmts, sessionId: string): boolean {
  try {
    const row = stmts.getActiveTask.get(sessionId) as { status?: string } | undefined;
    return row?.status === 'running';
  } catch {
    return false;
  }
}

/**
 * Best-effort: has the session's work landed? The authoritative "done/merged"
 * signal in Agent Hub is the linked kanban card sitting in a **Done column** —
 * what `card-auto-close.ts` writes when a PR merges. We reuse the shared
 * `isColumnDone` helper (`kanban-blockers.ts`) so the same case-insensitive
 * "name contains done" rule that resolves blockers also drives the merged
 * state. Note `kanban_cards.review_status` never holds `'merged'` (its CHECK
 * constraint allows only awaiting_review|reviewing|approved|changes_requested),
 * so column membership is the only durable local merge signal.
 *
 * Wrapped in try/catch so a unit-test DB lacking `kanban_cards` /
 * `kanban_columns` falls back to `false`.
 */
function lookupMergedForSession(stmts: Stmts, sessionId: string): boolean {
  try {
    const card = stmts.getKanbanCardBySession.get(sessionId) as
      | { column_id?: string | null }
      | undefined;
    if (!card?.column_id) return false;
    const col = stmts.getKanbanColumn.get(card.column_id) as { name?: string | null } | undefined;
    return isColumnDone(col?.name);
  } catch {
    return false;
  }
}

/** Gather the live signals for a session from the DB. */
export function gatherSessionStateSignals(stmts: Stmts, sessionId: string): SessionStateSignals {
  return {
    finalizeStatus: lookupFinalizeStatusForSession(stmts, sessionId),
    hasActiveTask: lookupHasActiveTask(stmts, sessionId),
    merged: lookupMergedForSession(stmts, sessionId),
  };
}

/** Resolve the current state for a session straight from the DB signals. */
export function computeSessionState(stmts: Stmts, sessionId: string): SessionState {
  return resolveSessionState(gatherSessionStateSignals(stmts, sessionId));
}

/** Broadcaster callback shape (matches the WebSocket `broadcast` helper). */
type Broadcast = (msg: Record<string, unknown>) => void;

/**
 * Recompute a session's state, persist it to `sessions.state`, and broadcast a
 * `session_state` event so clients update their single status icon without a
 * full refetch. Returns the resolved state.
 *
 * Wired into the production signal boundaries that change a session's resolved
 * state: chat turn start/end (`chat.ts`, around the `active_tasks` insert/delete
 * + awaiting-input broadcast), the linked-card auto-close path (`card-auto-close
 * .ts`), and the kanban move route (`routes/board.ts`) — the last being the
 * live `merged` trigger when a PR merge or human drag lands the card in Done.
 * Finalize-phase states still reach clients via the existing
 * `finalize_run_phase_changed` event (the orchestrator's `stmts` is a narrow
 * `Pick` without the lookups this resolver needs); `enrichSessionForClient`
 * remains the authoritative read-time resolver in every case.
 *
 * Best-effort and side-effect-tolerant: a missing `updateSessionState`
 * statement (older test DBs) or a throwing broadcast never propagates.
 */
export function recomputeSessionState(
  stmts: Stmts,
  sessionId: string,
  opts: { agentId?: string | null; broadcast?: Broadcast } = {},
): SessionState {
  const state = computeSessionState(stmts, sessionId);
  try {
    stmts.updateSessionState?.run(state, sessionId);
  } catch {
    // column/statement not present — serialization still resolves on read.
  }
  if (opts.broadcast) {
    try {
      opts.broadcast({
        type: 'session_state',
        sessionId,
        agentId: opts.agentId ?? null,
        state,
      });
    } catch {
      // best-effort live update.
    }
  }
  return state;
}
