import type { ChildProcess } from 'child_process';
import { killProcessGroup } from './process-groups.js';
import { markSessionTermination } from './process-termination.js';
import { requestReactChainCancel } from './react-chain-cancel.js';

/** How long a SIGTERMed CLI gets to exit before Stop escalates to SIGKILL. */
export const CANCEL_SIGKILL_GRACE_MS = 5000;

export interface SessionChatCancelDeps {
  sessionId: string;
  activeProcesses: Map<string, ChildProcess>;
  /** Injectable for tests; defaults to `setTimeout`. */
  scheduleEscalation?: (fn: () => void, ms: number) => unknown;
}

/**
 * WebSocket `cancel` / Stop: SIGTERM the in-flight CLI for this session.
 * Marks `user_cancel` so the chat `close` handler can log source + system line.
 *
 * Always requests a ReAct chain-cancel — even when no CLI process is active.
 * Stop can land between turns (host actions running in the close handler, or
 * the setImmediate gap before the next auto-continuation spawns) where the
 * SIGTERM has nothing to kill; the flag is what stops the chain in that window.
 *
 * SIGTERM alone is not enough. Every terminal frame the client needs to leave
 * its streaming state is emitted from the chat `close` handler, so a child that
 * traps or blocks SIGTERM leaves the session spinning forever with no way back
 * short of a reload. Escalate to SIGKILL — which cannot be caught — once the
 * grace window passes and the child is still registered (the `close` handler
 * removes it, so a live entry means it never exited).
 */
export function cancelSessionChatRun(deps: SessionChatCancelDeps): void {
  const { sessionId, activeProcesses } = deps;
  requestReactChainCancel(sessionId);
  const proc = activeProcesses.get(sessionId);
  if (!proc) return;
  markSessionTermination(sessionId, 'user_cancel');
  console.info(`[chat] user_cancel: sending SIGTERM session=${sessionId}`);
  killProcessGroup(proc, 'SIGTERM');

  const schedule = deps.scheduleEscalation ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
  schedule(() => {
    if (activeProcesses.get(sessionId) !== proc) return;
    console.warn(
      `[chat] user_cancel: SIGTERM ignored after ${CANCEL_SIGKILL_GRACE_MS}ms, escalating to SIGKILL session=${sessionId}`,
    );
    killProcessGroup(proc, 'SIGKILL');
  }, CANCEL_SIGKILL_GRACE_MS);
}
