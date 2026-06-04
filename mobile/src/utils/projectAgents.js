// Resolve the agent id to use for project-scoped actions (e.g. "Resolve PR")
// from a project record. The `project.agents` field historically came back
// from the server as either:
//   - an array of agent-id strings (older clients / some cached payloads)
//   - an array of agent objects with an `id` field (current shape)
// Returns `null` when no usable agent can be found.
export function resolveAgentIdFromProject(project) {
  if (!project || !Array.isArray(project.agents) || project.agents.length === 0) {
    return null;
  }
  const first = project.agents[0];
  if (typeof first === 'string') return first || null;
  if (first && typeof first === 'object' && typeof first.id === 'string') {
    return first.id || null;
  }
  return null;
}
