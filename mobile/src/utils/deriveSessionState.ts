import {
  resolveSessionState,
  DEFAULT_SESSION_STATE,
  isNeedsInputKind,
  liveNeedsInputKind,
} from '@shared/utils/sessionState';
export function deriveSessionState(session: any, signals: any = {}) {
  if (!session) return DEFAULT_SESSION_STATE;
  const { activeTaskSessionIds = {}, finalizeStatusBySession = {} } = signals;
  const hasActiveTask = !!activeTaskSessionIds[session.id];
  const liveFinalize = finalizeStatusBySession[session.id];
  const finalizeStatus = liveFinalize ?? session.finalize_status ?? null;
  const merged = session.state === 'merged';
  const kind = sessionNeedsInputKind(session, signals);
  const needsInput = isNeedsInputKind(kind) ? kind : null;
  // Mobile has no live shell map; the server pushes this state via `session_state`.
  const hasRunningBackgroundShell = session.state === 'waiting_on_background';
  const derived = resolveSessionState({
    finalizeStatus,
    hasActiveTask,
    hasRunningBackgroundShell,
    merged,
    needsInput,
  });
  if (
    derived === DEFAULT_SESSION_STATE &&
    !hasActiveTask &&
    liveFinalize == null &&
    session.state &&
    session.state !== DEFAULT_SESSION_STATE &&
    // needs_input has its own live signal above; a stale seed must not revive it.
    session.state !== 'needs_input' &&
    session.state !== 'waiting_on_background'
  ) {
    return session.state;
  }
  return derived;
}

/**
 * What a session is waiting on the human for. A live `session_needs_input`
 * entry (including an explicit clear) wins over the session payload's
 * `needs_input`; see `liveNeedsInputKind`.
 */
export function sessionNeedsInputKind(session: any, signals: any = {}): string | null {
  return liveNeedsInputKind(session, signals?.needsInputBySession);
}
