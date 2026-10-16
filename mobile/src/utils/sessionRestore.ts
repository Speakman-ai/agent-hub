/**
 * The active agent's live session list after `restored` comes back from the
 * archive. A session restored for any other agent (the drawer can restore
 * inactive agents' sessions) leaves the list untouched.
 */
export function withRestoredSession<T extends { id?: string; agent_id?: string }>(
  sessions: T[],
  restored: T | null | undefined,
  activeAgentId: string | null | undefined,
): T[] {
  if (!restored?.id || !activeAgentId || restored.agent_id !== activeAgentId) return sessions;
  if (sessions.some((s) => s.id === restored.id)) return sessions;
  return [restored, ...sessions];
}
