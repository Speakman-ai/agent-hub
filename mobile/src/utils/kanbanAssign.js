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
