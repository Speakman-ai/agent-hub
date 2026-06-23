/**
 * Derive UI flags from session rows returned by the API.
 *
 * SQLite stores 0/1 integers; older payloads may omit fields. Crucially,
 * `undefined !== 0` is true in JavaScript — never write `session?.ask_mode !== 0`
 * without coalescing, or Ask mode flips on whenever the active row is missing
 * from the in-memory list (agent switch races, optimistic navigation, etc.).
 */

export function isSessionAskModeEnabled(session: any) {
  return Number(session?.ask_mode ?? 0) !== 0;
}

/** Server default for new sessions is use_worktree = 1 — match when the row is absent. */
export function isSessionWorktreeEnabled(session: any) {
  return Number(session?.use_worktree ?? 1) !== 0;
}

/** True when the session row already has a provisioned worktree path (preview-safe). */
export function isSessionWorkspaceReady(session: any) {
  if (!isSessionWorktreeEnabled(session)) return true;
  const p = session?.worktree_path;
  return typeof p === 'string' && p.trim().length > 0;
}

/**
 * Prepend a session to the sidebar list unless it is already present.
 * POST /sessions broadcasts `session_created` before the HTTP body returns;
 * without this, the REST path and WebSocket both insert the same row.
 */
export function prependSessionDeduped(prev: any, session: any) {
  if (!session?.id) return prev;
  if (prev.some((s: any) => s.id === session.id)) return prev;
  return [session, ...prev];
}
