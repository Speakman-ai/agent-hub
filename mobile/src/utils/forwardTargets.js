/**
 * Given the flat agent list (agents with a `projectId` attached) and the
 * source agent of the session being forwarded, return the candidate agents
 * the session can be forwarded to. Rules:
 *   - Must be active (`active !== false`)
 *   - Must belong to the same project as the source agent
 *   - Must not be the source agent itself (self-forward is allowed by the
 *     backend, but hidden here so the picker doesn't feel ambiguous)
 *
 * Mirrors the web client's ForwardSessionModal filter so both platforms agree
 * on which agents show up in the picker.
 */
export function filterForwardTargets(agents, sourceAgent) {
  if (!Array.isArray(agents) || !sourceAgent) return [];
  const sourceProjectId = sourceAgent.projectId;
  if (!sourceProjectId) return [];
  return agents.filter(
    (a) =>
      a &&
      a.active !== false &&
      a.projectId === sourceProjectId &&
      a.id !== sourceAgent.id,
  );
}
