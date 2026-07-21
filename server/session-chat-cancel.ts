import type { ChildProcess } from 'child_process';
import { killProcessGroup } from './process-groups.js';
import { markSessionTermination } from './process-termination.js';
import { requestReactChainCancel } from './react-chain-cancel.js';

export interface SessionChatCancelDeps {
  sessionId: string;
  activeProcesses: Map<string, ChildProcess>;
}

/**
 * WebSocket `cancel` / Stop: SIGTERM the in-flight CLI for this session.
 * Marks `user_cancel` so the chat `close` handler can log source + system line.
 *
 * Always requests a ReAct chain-cancel — even when no CLI process is active.
 * Stop can land between turns (host actions running in the close handler, or
 * the setImmediate gap before the next auto-continuation spawns) where the
 * SIGTERM has nothing to kill; the flag is what stops the chain in that window.
 */
export function cancelSessionChatRun(deps: SessionChatCancelDeps): void {
  const { sessionId, activeProcesses } = deps;
  requestReactChainCancel(sessionId);
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    markSessionTermination(sessionId, 'user_cancel');
    console.info(`[chat] user_cancel: sending SIGTERM session=${sessionId}`);
    killProcessGroup(proc, 'SIGTERM');
  }
}
