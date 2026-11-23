/**
 * "Auto-fix a red default branch" setting (`project.ciOnPush.autoFix`), shown
 * under CI on push on web (`CiRunsSection`) and mobile (`RunnersScreen`).
 */

export const DEFAULT_BRANCH_AUTOFIX_LABEL = 'Auto-fix a red default branch';

export const DEFAULT_BRANCH_AUTOFIX_HINT =
  'When these jobs fail on the default branch, assign the breakage card to an agent so a fix ' +
  'session starts right away. One session per breakage. It runs as the person whose merge is in ' +
  'the failing range when they can, else the org owner.';

export interface AutoFixAgentOption {
  id: string;
  name: string;
}

/**
 * Agents that can work the fix session: active, and not the Reviewer or QA
 * agent. Matches `pickDefaultBranchFixAgent` on the server, which ignores a
 * configured agent outside this set.
 */
export function defaultBranchFixAgentOptions(project: unknown): AutoFixAgentOption[] {
  const agents = (project as { agents?: unknown } | null | undefined)?.agents;
  if (!Array.isArray(agents)) return [];
  return agents
    .filter(
      (a): a is { id: string; name?: string; role?: string; active?: boolean } =>
        !!a &&
        typeof a.id === 'string' &&
        a.id !== '' &&
        a.active !== false &&
        a.role !== 'reviewer' &&
        a.role !== 'qa',
    )
    .map((a) => ({ id: a.id, name: a.name || a.id }));
}
