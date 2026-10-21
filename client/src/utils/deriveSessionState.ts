import {
  resolveSessionState,
  DEFAULT_SESSION_STATE,
  isNeedsInputKind,
  liveNeedsInputKind,
} from '@shared/utils/sessionState';

/**
 * Derive a session's always-on lifecycle state on the client from the live
 * signal maps the sidebar already holds, falling back to the server-resolved
 * `session.state` seed for late-pipeline states (pushed / merged) that have no
 * standalone live client signal.
 *
 * Live signals always win over the seed so the icon updates the instant a WS
 * event lands; the seed only fills the gap before any signal has arrived.
 *
 * @param {{ id: string, state?: string|null, finalize_status?: string|null }} session
 * @param {{
 *   activeTaskSessionIds?: Record<string, unknown>,
 *   finalizeStatusBySession?: Record<string, string>,
 *   needsInputBySession?: Record<string, string | null>,
 * }} [signals]
 * @returns {string} one of shared SESSION_STATES
 */
export function deriveSessionState(session: any, signals: any = {}) {
  if (!session) return DEFAULT_SESSION_STATE;
  const { activeTaskSessionIds = {}, finalizeStatusBySession = {} } = signals;

  const hasActiveTask = !!activeTaskSessionIds[session.id];
  // Prefer a live finalize status pushed over WS; fall back to the value the
  // server stamped onto the session payload at load time.
  const liveFinalize = finalizeStatusBySession[session.id];
  const finalizeStatus = liveFinalize ?? session.finalize_status ?? null;
  // `merged` has no live client signal — trust the server-resolved seed.
  const merged = session.state === 'merged';

  const kind = sessionNeedsInputKind(session, signals);
  const needsInput = isNeedsInputKind(kind) ? kind : null;

  const derived = resolveSessionState({ finalizeStatus, hasActiveTask, merged, needsInput });

  // If nothing live or payload-derived put us past the default, but the server
  // already resolved a more-advanced settled state (e.g. `pushed`), keep it.
  if (
    derived === DEFAULT_SESSION_STATE &&
    !hasActiveTask &&
    liveFinalize == null &&
    session.state &&
    session.state !== DEFAULT_SESSION_STATE &&
    // needs_input has its own live signal above; a stale seed must not revive it.
    session.state !== 'needs_input'
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
