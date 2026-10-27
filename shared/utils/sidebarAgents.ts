/**
 * Seeded helper agents that have their own pages (Reviewer, Skill Builder,
 * QA) and should not appear as agent rows in the web sidebar or mobile drawer.
 */
export const SIDEBAR_HIDDEN_AGENT_ROLES: readonly string[] = ['reviewer', 'skill-builder', 'qa'];

export function isSidebarHiddenAgent(agent: { role?: string | null } | null | undefined): boolean {
  return !!agent?.role && SIDEBAR_HIDDEN_AGENT_ROLES.includes(agent.role);
}
