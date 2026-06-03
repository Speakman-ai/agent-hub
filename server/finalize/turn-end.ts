/**
 * turn-end.ts — in-process turn-end bus for Finalize Code Changes.
 *
 * Production wires {@link finalizeTurnEndSubscriber} into the fix-dispatch
 * loop and the rebase conflict `dispatchAndWaitForTurnEnd` seam.
 * {@link notifyFinalizeSessionTurnEnd} is called from `chat.ts` when an
 * assistant turn completes normally; {@link notifyFinalizeSessionSpawnFailed}
 * unblocks fix-dispatch waits when the CLI never started (E2BIG, ENOENT, …).
 */
import type { TurnEndSubscriber } from './fix-dispatch.js';

type TurnEndListener = (outcome: 'turn_ended' | 'spawn_failed') => void;

const listenersBySession = new Map<string, Set<TurnEndListener>>();

/**
 * Shared production {@link TurnEndSubscriber}. One singleton per server
 * process — safe because Finalize runs are keyed by session id.
 */
export const finalizeTurnEndSubscriber: TurnEndSubscriber = {
  subscribe(sessionId: string, onTurnEnd: TurnEndListener): () => void {
    if (!sessionId) return () => undefined;
    let set = listenersBySession.get(sessionId);
    if (!set) {
      set = new Set();
      listenersBySession.set(sessionId, set);
    }
    set.add(onTurnEnd);
    return () => {
      set!.delete(onTurnEnd);
      if (set!.size === 0) listenersBySession.delete(sessionId);
    };
  },
};

function notifyListeners(sessionId: string, outcome: 'turn_ended' | 'spawn_failed'): void {
  if (!sessionId) return;
  const set = listenersBySession.get(sessionId);
  if (!set || set.size === 0) return;
  for (const listener of [...set]) {
    try {
      listener(outcome);
    } catch {
      // A subscriber threw — do not block other waiters or chat teardown.
    }
  }
}

/**
 * Fire all turn-end listeners registered for `sessionId`. Called from the
 * chat handler after `type: 'done'` is broadcast.
 */
export function notifyFinalizeSessionTurnEnd(sessionId: string): void {
  notifyListeners(sessionId, 'turn_ended');
}

/**
 * Unblock fix-dispatch / rebase waits when agent spawn failed before a
 * real turn completed (argv too large, missing binary, etc.).
 */
export function notifyFinalizeSessionSpawnFailed(sessionId: string): void {
  notifyListeners(sessionId, 'spawn_failed');
}

/** Test-only reset. */
export function __testResetFinalizeTurnEndListeners(): void {
  listenersBySession.clear();
}

/** Test-only introspection. */
export function __testFinalizeTurnEndListenerCount(sessionId: string): number {
  return listenersBySession.get(sessionId)?.size ?? 0;
}
