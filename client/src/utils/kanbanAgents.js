/**
 * Helpers for the kanban card agent-assignment dropdown.
 *
 * Agents are loaded app-wide (flattened across every project the user can
 * view) and passed down as a prop. When assigning an agent to a card we only
 * ever want the agents that belong to the card's own project — showing agents
 * from unrelated projects is confusing and can't produce a valid assignment.
 */

/**
 * Filter an app-wide agent list down to the agents that belong to a project.
 *
 * Each agent row is enriched with `projectId` at the app level (see App.jsx
 * flattening of `GET /api/projects`). When `projectId` is falsy we return the
 * list unchanged rather than hiding everything — callers without a project
 * context (should not happen on the board, but defensively) still see agents.
 *
 * @param {Array<{projectId?: string}>} agents
 * @param {string} [projectId]
 * @returns {Array} agents scoped to the project
 */
export function filterAgentsByProject(agents, projectId) {
  if (!Array.isArray(agents)) return [];
  if (!projectId) return agents;
  return agents.filter((a) => a && a.projectId === projectId);
}
