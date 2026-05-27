/** Group agents by project for the multi-agent session advisor picker. */

export function filterAgentsForPicker(agents, { query = '', excludeIds = new Set() } = {}) {
  const q = query.trim().toLowerCase();
  return agents.filter((a) => {
    if (a.active === false || excludeIds.has(a.id)) return false;
    if (!q) return true;
    const name = (a.name || '').toLowerCase();
    const project = (a.projectName || a.projectId || '').toLowerCase();
    const id = (a.id || '').toLowerCase();
    return name.includes(q) || project.includes(q) || id.includes(q);
  });
}

export function groupAgentsByProject(agents) {
  const groups = new Map();
  for (const agent of agents) {
    const projectId = agent.projectId || 'unknown';
    const projectName = agent.projectName || 'Other project';
    if (!groups.has(projectId)) {
      groups.set(projectId, { projectId, projectName, agents: [] });
    }
    groups.get(projectId).agents.push(agent);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      agents: g.agents.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    }))
    .sort((a, b) => a.projectName.localeCompare(b.projectName));
}
