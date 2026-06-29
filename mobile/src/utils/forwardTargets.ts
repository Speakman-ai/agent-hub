/**
 * Given the flat agent list (agents with a `projectId` attached) and the
 * source agent of the session being forwarded, return the candidate agents
 * the session can be forwarded to. Rules:
 *   - Must be active (`active !== false`)
 *   - Agents from **any** project the caller can see are eligible — the
 *     agent list is already visibility-filtered server-side and the forward
 *     route re-checks target-project access (cross-project forwarding).
 *   - Ordering: source agent first (self-forward), then same-project agents,
 *     then agents in other projects. Each row renders `projectName` so
 *     cross-project targets are distinguishable.
 *
 * Mirrors the web client's ForwardSessionModal filter so both platforms agree
 * on which agents show up in the picker.
 */
export function filterForwardTargets(agents: any, sourceAgent: any) {
    if (!Array.isArray(agents) || !sourceAgent)
        return [];
    const sourceProjectId = sourceAgent.projectId;
    const active = agents.filter((a: any) => a && a.active !== false);
    const self = active.find((a: any) => a.id === sourceAgent.id);
    const rest = active.filter((a: any) => a.id !== sourceAgent.id);
    const sameProject = rest.filter((a: any) => a.projectId === sourceProjectId);
    const otherProjects = rest.filter((a: any) => a.projectId !== sourceProjectId);
    const ordered = [...sameProject, ...otherProjects];
    return self ? [self, ...ordered] : ordered;
}
