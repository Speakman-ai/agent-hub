import { recomputeSessionState } from './session-state.js';
import type { Stmts } from './types.js';

/**
 * A chat turn whose `activeProcesses` handle was displaced still owns its
 * `active_tasks` row when that row carries the turn's message id. Delete it
 * (and refresh the session's state) so the session does not read as `working`
 * after the process is gone. A row for a newer turn has a different message
 * id and is left alone.
 */
export function clearOwnActiveTaskAfterDisplacedClose(
  stmts: Stmts,
  sessionId: string,
  messageId: string,
  opts: { agentId?: string | null; broadcast?: (msg: Record<string, unknown>) => void } = {},
): boolean {
  let removed = false;
  try {
    const result = stmts.deleteActiveTaskForMessage.run(sessionId, messageId) as
      | { changes?: number }
      | undefined;
    removed = (result?.changes ?? 0) > 0;
  } catch {
    return false;
  }
  if (removed) recomputeSessionState(stmts, sessionId, opts);
  return removed;
}
