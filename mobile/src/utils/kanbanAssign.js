// Pure helpers for the kanban-card "Assign agent" flow on mobile. Kept in
// src/utils/ so they're covered by the existing vitest config
// (include: ['src/utils/**/*.test.js']).

/**
 * Look up an agent in the context list by its display name. The server stores
 * `card.assignee` as the agent's *name* (not id), matching the web client's
 * behaviour in `KanbanBoard.jsx`.
 *
 * @param {Array<{id: string, name: string}>} agents
 * @param {string} name
 * @returns {{id: string, name: string} | undefined}
 */
export function findAgentByName(agents, name) {
  if (!Array.isArray(agents) || !name) return undefined;
  return agents.find((a) => a && a.name === name);
}

/**
 * Returns true when the card has an active session and should show the
 * "Session active" state with Open Session / Reassign buttons, instead of
 * the agent picker.
 */
export function hasActiveSession(card) {
  return !!(card && card.session_id);
}

/**
 * Scope an app-wide agent list to a single project. Agents are loaded
 * globally (every project the user can view) and carry a `projectId`; the
 * assignee picker should only offer agents that belong to the card's own
 * project. A falsy `projectId` returns the list unchanged so callers without
 * a project context still see agents.
 *
 * @param {Array<{projectId?: string}>} agents
 * @param {string} [projectId]
 */
export function filterAgentsByProject(agents, projectId) {
  if (!Array.isArray(agents)) return [];
  if (!projectId) return agents;
  return agents.filter((a) => a && a.projectId === projectId);
}

/**
 * Build the dropdown option list for the assignee picker modal:
 * an "Unassigned" row plus one row per known agent.
 *
 * @param {Array<{id: string, name: string}>} agents
 */
export function buildAssigneeOptions(agents) {
  const base = [{ id: '', name: 'Unassigned' }];
  if (!Array.isArray(agents)) return base;
  return base.concat(
    agents
      .filter((a) => a && a.id && a.name)
      .map((a) => ({ id: a.id, name: a.name })),
  );
}

/**
 * Resolve the engine the spawned session will actually run under for a given
 * card assignment. Returns the optional `overrideEngine` when set (matching
 * the server's `assign_engine` column), otherwise the agent's configured
 * engine, falling back to `claude-code` so the model picker always has a
 * deterministic key to look up.
 */
export function effectiveAssignEngine(agents, agentName, overrideEngine) {
  const trimmed = (overrideEngine || '').trim();
  if (trimmed) return trimmed;
  const agent = findAgentByName(agents, agentName);
  return agent?.engine || 'claude-code';
}

/**
 * Models that are valid for the engine the card would spawn under. When
 * `overrideEngine` is set the picker filters on the override; otherwise it
 * falls back to the agent's configured engine. Mirrors the web client's
 * inline `effectiveEngine` lookup in `KanbanBoard.jsx`.
 *
 * @param {Array<{id: string, name: string, engine?: string}>} agents
 * @param {{engineValidModels?: Record<string, string[]>}} modelConfig
 * @param {string} agentName
 * @param {string} [overrideEngine]
 */
export function validModelsForAgent(agents, modelConfig, agentName, overrideEngine) {
  if (!modelConfig?.engineValidModels) return [];
  // No agent yet → caller is mid-picker; nothing to filter on.
  const agent = findAgentByName(agents, agentName);
  if (!agent && !overrideEngine) return [];
  const eng = effectiveAssignEngine(agents, agentName, overrideEngine);
  return modelConfig.engineValidModels[eng] || [];
}

/**
 * Engines the operator may override the spawn to — every key on
 * `modelConfig.engineValidModels` whose model list is non-empty (i.e. the
 * user is authenticated for that engine). Mirrors the web client's
 * `engineEntries` filter in `KanbanBoard.jsx`.
 *
 * @param {{engineValidModels?: Record<string, string[]>}} modelConfig
 * @returns {string[]}
 */
export function engineEntriesWithModels(modelConfig) {
  const map = modelConfig?.engineValidModels;
  if (!map) return [];
  return Object.keys(map).filter((eng) => (map[eng]?.length ?? 0) > 0);
}
