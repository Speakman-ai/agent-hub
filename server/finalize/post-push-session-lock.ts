import type { FinalizeRunRow, Stmts } from '../types.js';

export const POST_FINALIZE_PUSH_LOCK_ERROR = 'session_finalized_pushed';
export const POST_FINALIZE_PUSH_LOCK_MESSAGE =
  'This session already pushed code through Finalize. It is locked in ask mode; start a new session for follow-up changes.';

export type PostFinalizePushLockStmts = Pick<
  Stmts,
  'getPushedFinalizeRunForSession' | 'updateSessionAskMode' | 'updateSessionFinalizeAutomation'
>;

export function hasPushedFinalizeRun(
  stmts: Pick<Stmts, 'getPushedFinalizeRunForSession'>,
  sessionId: string | null | undefined,
): boolean {
  if (!sessionId) return false;
  const pushed = stmts.getPushedFinalizeRunForSession.get(sessionId) as FinalizeRunRow | undefined;
  return pushed?.status === 'pushed';
}

export function lockSessionAfterFinalizePush(
  stmts: Pick<Stmts, 'updateSessionAskMode' | 'updateSessionFinalizeAutomation'>,
  sessionId: string | null | undefined,
): void {
  if (!sessionId) return;
  stmts.updateSessionAskMode.run(1, sessionId);
  stmts.updateSessionFinalizeAutomation.run('manual', sessionId);
}
