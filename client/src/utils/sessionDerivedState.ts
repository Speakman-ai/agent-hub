/**
 * Derive UI flags from session rows returned by the API.
 *
 * SQLite stores 0/1 integers; older payloads may omit fields. Crucially,
 * `undefined !== 0` is true in JavaScript — never write `session?.ask_mode !== 0`
 * without coalescing, or Consult mode flips on whenever the active row is missing
 * from the in-memory list (agent switch races, optimistic navigation, etc.).
 */

/** True when the session is in Consult (Hub-only, no code ship / Finalize). */
export function isSessionConsultModeEnabled(session: any) {
  if (session?.session_mode === 'consult') return true;
  return Number(session?.ask_mode ?? 0) !== 0;
}

/** @deprecated Use isSessionConsultModeEnabled — legacy ask_mode rows map to Consult. */
export function isSessionAskModeEnabled(session: any) {
  return isSessionConsultModeEnabled(session);
}

/** Server default for new sessions is use_worktree = 1 — match when the row is absent. */
export function isSessionWorktreeEnabled(session: any) {
  return Number(session?.use_worktree ?? 1) !== 0;
}

/**
 * Whether the "Changes" (code diff) toolbar button should render.
 *
 * Consult mode only suppresses code-*ship* actions (Finalize / Push) — not
 * read-only inspection of what a session already produced. A session that ships
 * its work flips to Consult ("Pushed to Agent Hub"), and users still need to see
 * the diff it pushed, so keep the button when the session has a worktree even in
 * Consult. Workflow (no-code) projects never expose worktree diffs.
 */
export function shouldShowSessionChangesButton(args: {
  isWorkflowProject: boolean;
  consultActive: boolean;
  session: any;
}) {
  if (args.isWorkflowProject) return false;
  // Non-consult behavior is unchanged: the button always shows.
  if (!args.consultActive) return true;
  // In Consult, only surface it when the session has a worktree to diff.
  return isSessionWorktreeEnabled(args.session);
}

/** True when the session row already has a provisioned worktree path (preview-safe). */
export function isSessionWorkspaceReady(session: any) {
  if (!isSessionWorktreeEnabled(session)) return true;
  const p = session?.worktree_path;
  return typeof p === 'string' && p.trim().length > 0;
}

/**
 * Whether opening this session should POST /workspace/ensure.
 *
 * A persisted `worktree_path` only proves the git clone happened once. The
 * session VM/container is in-memory and can be gone after a Hub restart or
 * idle reap while the path row survives, so we must NOT gate on
 * `isSessionWorkspaceReady` here — an already-cloned session with a dead
 * environment still needs an ensure to reboot the VM before the first chat.
 * The ensure fires for every worktree-enabled session; the server route is
 * idempotent (reuses the clone and a live env, boots one only when missing).
 * Non-worktree / workflow sessions never need it.
 */
export function shouldEnsureSessionWorkspaceOnOpen(session: any): boolean {
  if (!session) return false;
  return isSessionWorktreeEnabled(session);
}

/**
 * Immutably drop a session's key from a by-session flag map.
 *
 * Used to reset per-session open-time ensure state (the "settled" map) when
 * leaving a session, so the reopen models readiness per activation instead of
 * once per browser lifetime. Without this, a session whose VM was idle-reaped
 * while the user worked elsewhere would reopen already marked ready — the
 * composer would accept input against a dead environment and the first chat
 * would pay the boot delay. The companion "attempted" Set is cleared alongside
 * this (a plain `Set.delete`) so the ensure effect re-fires on reopen.
 */
export function withoutSessionKey<T extends Record<string, any>>(
  map: T,
  sid: string | null | undefined,
): T {
  if (!sid || !(sid in map)) return map;
  const next = { ...map };
  delete next[sid];
  return next;
}

/**
 * Decide what the open-time workspace-ensure effect should do for a session.
 *
 * - `'skip'`  — this activation already registered an attempt; do nothing.
 * - `'adopt'` — a prior request for this session is still in flight (rapid
 *   leave→reopen). Register the attempt but do NOT issue a second request: the
 *   in-flight request's settle handler re-checks the attempted flag and marks
 *   this activation ready. Issuing a racing request instead would double-POST,
 *   and skipping outright would strand the composer gated forever (the old
 *   request refuses to settle a session whose attempt was cleared on leave, and
 *   the effect's dependencies do not change to trigger a retry).
 * - `'issue'` — no request is in flight; start a fresh ensure.
 */
export function planWorkspaceEnsureOnOpen(args: {
  attempted: boolean;
  inFlight: boolean;
}): 'skip' | 'adopt' | 'issue' {
  if (args.attempted) return 'skip';
  if (args.inFlight) return 'adopt';
  return 'issue';
}

/**
 * Whether the chat composer may be enabled for the active session.
 *
 * A session that needs an open-time ensure is only composer-ready once that
 * ensure has settled (resolved or failed). Gating synchronously on this —
 * rather than on the `ensuring` flag the effect sets after render — closes
 * the first-render window where the composer would briefly accept input
 * against a not-yet-ready workspace. On ensure failure we still report ready
 * so the user is not stranded; the chat turn re-ensures the environment.
 */
export function isSessionComposerWorkspaceReady(args: {
  needsEnsure: boolean;
  settled: boolean;
}): boolean {
  return !args.needsEnsure || args.settled;
}

/**
 * Whether the session composer must reject input.
 *
 * Workspace setup in progress is deliberately absent: handleChat persists the
 * message as queued while the server's setup lock is held. A failed setup does
 * remain blocking until Retry succeeds, and connection/agent gates are
 * unchanged.
 */
export function shouldDisableSessionComposer(args: {
  hasAgent: boolean;
  connected: boolean;
  workspaceEnsureFailed: boolean;
}): boolean {
  return !args.hasAgent || !args.connected || args.workspaceEnsureFailed;
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

/**
 * Apply a remote `session_created` WebSocket event to sidebar caches.
 *
 * Unlike {@link planCreatedSessionCaches} (the HTTP create path), this must
 * not invent a cache entry for an agent that has never been fetched. The
 * expand-agent loader skips a fetch when a cache key already exists, so a
 * one-row seed would hide that agent's other sessions until a full reload.
 * Only prepend when the agent is already cached, or when its list is the
 * live `sessions` array.
 */
export function planRemoteSessionCreatedCaches(args: {
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
  const nextSessions =
    loadedSessionsAgentId === targetAgentId ? prependSessionDeduped(sessions, session) : sessions;
  if (!Object.prototype.hasOwnProperty.call(sessionsByAgentId, targetAgentId)) {
    return { sessionsByAgentId, sessions: nextSessions };
  }
  return {
    sessionsByAgentId: {
      ...sessionsByAgentId,
      [targetAgentId]: prependSessionDeduped(sessionsByAgentId[targetAgentId] || [], session),
    },
    sessions: nextSessions,
  };
}
