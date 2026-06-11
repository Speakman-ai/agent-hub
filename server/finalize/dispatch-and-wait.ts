/**
 * dispatch-and-wait.ts — rebase conflict dispatch + turn-end wait seam.
 *
 * Used by `rebase.ts` when a non-trivial merge conflict must be resolved
 * in the originating session before the orchestrator re-enters the rebase
 * loop. Mirrors the message-insert path in `fix-dispatch.ts` but without
 * the stall watchdog (rebase owns the outer budget guard).
 */
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, MessageRow, Stmts } from '../types.js';
import type { TurnEndSubscriber } from './fix-dispatch.js';
import type { SpawnFinalizeFixTurnFn } from './spawn-fix-turn.js';

export interface DispatchAndWaitDeps {
  stmts: Pick<Stmts, 'addMessage' | 'getMessageById' | 'touchSession'>;
  broadcast: BroadcastFn;
  turnEnd: TurnEndSubscriber;
  /**
   * Spawn the originating session agent after the conflict system message
   * is inserted, so it actually works the conflict and ends a turn. Without
   * it, nothing triggers a turn in an autonomous/automated Finalize run:
   * the message is persisted + broadcast, the wait subscribes to turn-end,
   * and then the run hangs (status still `rebasing`) until the outer
   * active-time budget times out ~60 min later. Mirrors the fix-dispatch
   * path's `spawnFixTurn`. Optional so legacy callers / unit tests can drive
   * turn-end manually, but production MUST wire it (see `orchestrator-deps`).
   */
  spawnTurn?: SpawnFinalizeFixTurnFn;
  newId?: () => string;
  log?: (msg: string) => void;
}

export type DispatchAndWaitForTurnEnd = (args: {
  sessionId: string;
  cardId: string;
  body: string;
}) => Promise<{ userMessagePersisted: boolean }>;

/**
 * Build the production `dispatchAndWaitForTurnEnd` callback wired into
 * the rebase phase.
 */
export function createDispatchAndWaitForTurnEnd(
  deps: DispatchAndWaitDeps,
): DispatchAndWaitForTurnEnd {
  const newId = deps.newId ?? uuidv4;
  const log = deps.log ?? ((msg: string) => console.warn(msg));

  return async function dispatchAndWaitForTurnEnd(args: {
    sessionId: string;
    cardId: string;
    body: string;
  }): Promise<{ userMessagePersisted: boolean }> {
    const { sessionId, cardId, body } = args;
    if (!sessionId || !body.trim()) {
      return { userMessagePersisted: false };
    }

    const messageId = newId();
    const metadata = JSON.stringify({
      kind: 'finalize_rebase_conflict_dispatch',
      cardId,
    });

    try {
      deps.stmts.addMessage.run(
        messageId,
        sessionId,
        'system',
        body,
        null,
        null,
        null,
        metadata,
        null,
        null,
        null,
      );
    } catch (err) {
      log(
        `[finalize-dispatch-and-wait] addMessage failed for session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { userMessagePersisted: false };
    }

    try {
      deps.stmts.touchSession.run(sessionId);
    } catch {
      /* best-effort */
    }

    try {
      const inserted = deps.stmts.getMessageById.get(messageId) as MessageRow | undefined;
      if (inserted) {
        deps.broadcast({ type: 'message', sessionId, message: inserted });
      }
    } catch (err) {
      log(
        `[finalize-dispatch-and-wait] broadcast failed for session=${sessionId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        unsub();
        resolve({ userMessagePersisted: ok });
      };
      // Subscribe BEFORE spawning so a turn that ends synchronously during
      // the spawn (or a spawn-failed signal) is never missed.
      const unsub = deps.turnEnd.subscribe(sessionId, (outcome) => {
        if (outcome === 'spawn_failed') finish(false);
        else finish(true);
      });

      // Trigger the session agent to actually resolve the conflict. The
      // conflict body is sent as the turn content (not just persisted as a
      // system row) because a resumed CLI session does not see that row in
      // its own context — same reasoning as the fix-dispatch path.
      if (deps.spawnTurn) {
        void deps
          .spawnTurn({ sessionId, body })
          .then((res) => {
            if (!res.spawned) {
              log(
                `[finalize-dispatch-and-wait] agent spawn did not start for session=${sessionId} — conflict will not auto-resolve`,
              );
              finish(false);
            }
          })
          .catch((err: unknown) => {
            log(
              `[finalize-dispatch-and-wait] spawnTurn failed for session=${sessionId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            finish(false);
          });
      } else {
        log(
          `[finalize-dispatch-and-wait] spawnTurn not wired — session ${sessionId} will not auto-respond to the conflict dispatch; the run will hang until the active-time budget expires`,
        );
      }
    });
  };
}
