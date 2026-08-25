import { resolveSessionState, DEFAULT_SESSION_STATE } from '@shared/utils/sessionState';
export function deriveSessionState(session: any, signals: any = {}) {
  if (!session) return DEFAULT_SESSION_STATE;
  const { activeTaskSessionIds = {}, finalizeStatusBySession = {} } = signals;
  const hasActiveTask = !!activeTaskSessionIds[session.id];
  const liveFinalize = finalizeStatusBySession[session.id];
  const finalizeStatus = liveFinalize ?? session.finalize_status ?? null;
  const merged = session.state === 'merged';
  const derived = resolveSessionState({ finalizeStatus, hasActiveTask, merged });
  if (
    derived === DEFAULT_SESSION_STATE &&
    !hasActiveTask &&
    liveFinalize == null &&
    session.state &&
    session.state !== DEFAULT_SESSION_STATE
  ) {
    return session.state;
  }
  return derived;
}
