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

/**
 * Compute the next per-agent session cache and the next live `sessions` array
 * after a session is created for `targetAgentId`.
 *
 * The cache entry for the target agent ALWAYS gains the new session. The live
 * `sessions` array (the chat column's list) is only updated when it currently
 * belongs to the target agent — i.e. `loadedSessionsAgentId === targetAgentId`.
 *
 * Why the guard: `sessions` is tagged with the agent it was fetched for, not
 * `activeAgentId`. Creating a session for a not-yet-loaded agent (e.g. starting
 * Skill Builder for another project's dev agent) must NOT prepend the new row
 * onto the previously-loaded agent's `sessions`, because the cache-warming
 * effect would then stamp it under that previous agent — cross-agent cache
 * pollution. When the caller switches to the target agent, its fresh fetch
 * surfaces the persisted row anyway.
 */
export function planCreatedSessionCaches(args: {
  targetAgentId: string;
  loadedSessionsAgentId: string | null | undefined;
  session: any;
  sessionsByAgentId: Record<string, any[]>;
  sessions: any[];
}): { sessionsByAgentId: Record<string, any[]>; sessions: any[] } {
  const { targetAgentId, loadedSessionsAgentId, session, sessionsByAgentId, sessions } = args;
  if (!targetAgentId || !session?.id) {
    return { sessionsByAgentId, sessions };
  }
  const nextCache = {
    ...sessionsByAgentId,
    [targetAgentId]: prependSessionDeduped(sessionsByAgentId[targetAgentId] || [], session),
  };
  const nextSessions =
    loadedSessionsAgentId === targetAgentId ? prependSessionDeduped(sessions, session) : sessions;
  return { sessionsByAgentId: nextCache, sessions: nextSessions };
}
