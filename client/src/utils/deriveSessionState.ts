import { resolveSessionState, DEFAULT_SESSION_STATE } from '@shared/utils/sessionState';

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

  const derived = resolveSessionState({ finalizeStatus, hasActiveTask, merged });

  // If nothing live or payload-derived put us past the default, but the server
  // already resolved a more-advanced settled state (e.g. `pushed`), keep it.
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
