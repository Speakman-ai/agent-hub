import type { ChildProcess } from 'child_process';
import { killProcessGroup } from './process-groups.js';
import { markSessionTermination } from './process-termination.js';

export interface SessionChatCancelDeps {
  sessionId: string;
  activeProcesses: Map<string, ChildProcess>;
}

/**
 * WebSocket `cancel` / Stop: SIGTERM the in-flight CLI for this session.
 * Marks `user_cancel` so the chat `close` handler can log source + system line.
 */
export function cancelSessionChatRun(deps: SessionChatCancelDeps): void {
  const { sessionId, activeProcesses } = deps;
  const proc = activeProcesses.get(sessionId);
  if (proc) {
    markSessionTermination(sessionId, 'user_cancel');
    console.info(`[chat] user_cancel: sending SIGTERM session=${sessionId}`);
    killProcessGroup(proc, 'SIGTERM');
  }
}
