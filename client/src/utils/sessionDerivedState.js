/**
 * Derive UI flags from session rows returned by the API.
 *
 * SQLite stores 0/1 integers; older payloads may omit fields. Crucially,
 * `undefined !== 0` is true in JavaScript — never write `session?.ask_mode !== 0`
 * without coalescing, or Ask mode flips on whenever the active row is missing
 * from the in-memory list (agent switch races, optimistic navigation, etc.).
 */

export function isSessionAskModeEnabled(session) {
  return Number(session?.ask_mode ?? 0) !== 0;
}

/** Server default for new sessions is use_worktree = 1 — match when the row is absent. */
export function isSessionWorktreeEnabled(session) {
  return Number(session?.use_worktree ?? 1) !== 0;
}

/**
 * Prepend a session to the sidebar list unless it is already present.
 * POST /sessions broadcasts `session_created` before the HTTP body returns;
 * without this, the REST path and WebSocket both insert the same row.
 */
export function prependSessionDeduped(prev, session) {
  if (!session?.id) return prev;
  if (prev.some((s) => s.id === session.id)) return prev;
  return [session, ...prev];
}
