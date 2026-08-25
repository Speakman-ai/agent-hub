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
export function selectSessionToActivate(sessions: any, targetSessionId: any) {
  if (!Array.isArray(sessions) || sessions.length === 0) return null;
  if (targetSessionId) {
    const match = sessions.find((s: any) => s && s.id === targetSessionId);
    if (match) return match;
  }
  return sessions[0];
}

/**
 * Decide whether a deep-linked target should be fetched by id.
 *
 * The drawer session list (`GET /agents/:agentId/sessions`) is owner-only, so
 * a session the caller does not own — e.g. an org admin tapping another user's
 * row in the dashboard Active-sessions panel — is absent from `sessions`. The
 * server read-gate still lets an admin READ it by id, so when a target is
 * requested but missing from the owned list we return its id for a direct
 * fetch instead of silently snapping to the newest owned session.
 *
 * @returns The target session id to fetch directly, or null when the target
 *     is either owned (already in the list) or absent.
 */
export function deepLinkFetchId(sessions: any, targetSessionId: any) {
  if (!targetSessionId) return null;
  const list = Array.isArray(sessions) ? sessions : [];
  const owned = list.some((s: any) => s && s.id === targetSessionId);
  return owned ? null : targetSessionId;
}

/** Insert or replace a session row by id, keeping list order stable. */
export function upsertSessionRow(list: any, row: any) {
  const arr = Array.isArray(list) ? list : [];
  if (!row || !row.id) return arr;
  const idx = arr.findIndex((s: any) => s && s.id === row.id);
  if (idx === -1) return [row, ...arr];
  const next = arr.slice();
  next[idx] = row;
  return next;
}
