/**
 * Session selection helpers.
 *
 * Pure functions used by `AppContext`'s agent-change sessions-load effect so
 * the "pending target" vs "default to newest" logic can be unit-tested
 * without mounting the context provider. Mirrors the behaviour of the web
 * client at `client/src/App.jsx:1302-1304`:
 *
 *   const target = targetSessionId
 *     ? data.find((s) => s.id === targetSessionId) || data[0]
 *     : data[0];
 *
 * The reason this is its own module: the bug fixed by this helper — a
 * handoff "Open session" tap being clobbered by `setActiveSessionId(data[0].id)`
 * in the sessions-load effect — is context-level wiring that's hard to
 * exercise in a unit test. Extracting the decision into a pure helper lets
 * us lock the correctness property down.
 */

/**
 * Pick which session to activate when the sessions list arrives for a newly
 * selected agent.
 *
 * @param {Array<{id: string}>} sessions - The session list returned from the
 *     server (may be empty).
 * @param {string|null|undefined} targetSessionId - An explicitly requested
 *     target session (e.g. from a handoff "Open session" tap or a kanban
 *     assign). When present and the session exists in `sessions`, it wins.
 *     When present but not found, we fall back to the newest session so the
 *     user still lands somewhere usable (the requested session may have
 *     been deleted since the request was queued).
 * @returns {{id: string}|null} The chosen session row, or null when the
 *     sessions list is empty.
 */
export function selectSessionToActivate(sessions, targetSessionId) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (targetSessionId) {
    const match = sessions.find((s) => s && s.id === targetSessionId);
    if (match) return match;
  }
  return sessions[0];
}
