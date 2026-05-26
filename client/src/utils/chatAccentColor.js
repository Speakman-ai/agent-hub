const DEFAULT_CHAT_ACCENT = '#6366f1';

/**
 * Resolve the project accent color for a chat session.
 * Prefers the owning project's `color`, then the agent's `color`.
 *
 * @param {{
 *   sessionId?: string | null,
 *   sessionRow?: { agent_id?: string | null } | null,
 *   sessionsById?: Map<string, { agent_id?: string | null }>,
 *   agents?: Array<{ id: string, projectId?: string, color?: string }>,
 *   projects?: Array<{ id: string, color?: string }>,
 *   fallbackAgentId?: string | null,
 * }} opts
 */
export function resolveChatAccentColor({
  sessionId,
  sessionRow,
  sessionsById,
  agents = [],
  projects = [],
  fallbackAgentId,
}) {
  const row = sessionRow ?? (sessionId && sessionsById?.get(sessionId)) ?? null;
  const agentId = row?.agent_id ?? fallbackAgentId ?? null;
  if (!agentId) return DEFAULT_CHAT_ACCENT;

  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return DEFAULT_CHAT_ACCENT;

  const project = projects.find((p) => p.id === agent.projectId);
  return project?.color || agent.color || DEFAULT_CHAT_ACCENT;
}

/**
 * Merge session rows into a Map keyed by session id (mutates/returns the map).
 *
 * @param {Map<string, object>} map
 * @param {Array<{ id: string, agent_id?: string }>} rows
 */
export function indexSessionsById(map, rows) {
  if (!rows?.length) return map;
  for (const row of rows) {
    if (row?.id) map.set(row.id, row);
  }
  return map;
}
