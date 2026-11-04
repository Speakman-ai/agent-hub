/**
 * Whether a session row pushed over the WebSocket (`session_created`,
 * `session_restored`, `session_forwarded`) may be spliced into the caller's
 * sidebar.
 *
 * Those events are broadcast to every connected client, but the sidebar list
 * (`GET /api/agents/:agentId/sessions`) only returns the caller's own sessions
 * (`userOwnsSession` on the server). Splicing without this check makes other
 * users' sessions pop into the sidebar until the next refetch drops them.
 *
 * Mirrors the server rule: with no signed-in user id (local single-tenant
 * bundle, apiKey-only installs) every row is shown; otherwise only rows whose
 * `owner_user_id` matches. Unowned rows are hidden, as the list route does.
 */
export function isSessionVisibleInOwnSidebar(
  session: { owner_user_id?: string | null } | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!session) return false;
  if (!currentUserId) return true;
  return (session.owner_user_id ?? null) === currentUserId;
}
