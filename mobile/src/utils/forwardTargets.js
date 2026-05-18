/**
 * Given the flat agent list (agents with a `projectId` attached) and the
 * source agent of the session being forwarded, return the candidate agents
 * the session can be forwarded to. Rules:
 *   - Must be active (`active !== false`)
 *   - Must belong to the same project as the source agent
 *   - Source agent IS included (self-forward) and pinned at the top so
 *     "fork this conversation into a new session on the same agent" is
 *     the first, most discoverable option.
 *
 * Mirrors the web client's ForwardSessionModal filter so both platforms agree
 * on which agents show up in the picker.
 */
export function filterForwardTargets(agents, sourceAgent) {
  if (!Array.isArray(agents) || !sourceAgent) return [];
  const sourceProjectId = sourceAgent.projectId;
  if (!sourceProjectId) return [];
  const matches = agents.filter(
    (a) => a && a.active !== false && a.projectId === sourceProjectId,
  );
  const self = matches.find((a) => a.id === sourceAgent.id);
  const others = matches.filter((a) => a.id !== sourceAgent.id);
  return self ? [self, ...others] : others;
}
