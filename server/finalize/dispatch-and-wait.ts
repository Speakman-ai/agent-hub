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

export interface DispatchAndWaitDeps {
  stmts: Pick<Stmts, 'addMessage' | 'getMessageById' | 'touchSession'>;
  broadcast: BroadcastFn;
  turnEnd: TurnEndSubscriber;
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
      const unsub = deps.turnEnd.subscribe(sessionId, (outcome) => {
        if (outcome === 'spawn_failed') finish(false);
        else finish(true);
      });
    });
  };
}
