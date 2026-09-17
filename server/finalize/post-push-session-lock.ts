import type { FinalizeRunRow } from '../types.js';
import { isAutopilotModeActive } from '../session-mode.js';

export const POST_FINALIZE_PUSH_LOCK_ERROR = 'session_finalized_pushed';
export const POST_FINALIZE_PUSH_LOCK_MESSAGE =
  'This session already pushed code through Finalize. It is locked in ask mode; start a new session for follow-up changes.';

export type PushedFinalizeRunLookup = {
  getPushedFinalizeRunForSession: { get: (sessionId: string) => unknown };
};

export type PostFinalizePushLockStmts = PushedFinalizeRunLookup & {
  updateSessionAskMode: { run: (...args: unknown[]) => unknown };
  updateSessionFinalizeAutomation: { run: (...args: unknown[]) => unknown };
};

export function hasPushedFinalizeRun(
  stmts: PushedFinalizeRunLookup,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const pushed = stmts.getPushedFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
  return pushed?.status === 'pushed';
}

/** Autopilot sessions may Finalize-push repeatedly on the same named branch. */
export function sessionAllowsRepeatFinalizePush(
  session: { session_mode?: string | null } | null | undefined,
): boolean {
  return isAutopilotModeActive(session);
}

export function sessionIsLockedAfterFinalizePush(
  stmts: PushedFinalizeRunLookup,
  session: { id?: string | null; session_mode?: string | null } | null | undefined,
): boolean {
  if (!session?.id) return false;
  if (sessionAllowsRepeatFinalizePush(session)) return false;
  return hasPushedFinalizeRun(stmts, session.id);
}

export function lockSessionAfterFinalizePush(
  stmts: Pick<
    PostFinalizePushLockStmts,
    'updateSessionAskMode' | 'updateSessionFinalizeAutomation'
  >,
  sessionId: string | null | undefined,
  session?: { session_mode?: string | null } | null,
): void {
  if (!sessionId) return;
  if (sessionAllowsRepeatFinalizePush(session)) return;
  stmts.updateSessionAskMode.run(1, sessionId);
  stmts.updateSessionFinalizeAutomation.run('manual', sessionId);
}
