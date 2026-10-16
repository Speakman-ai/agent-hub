/**
 * Where a project's scheduled tasks render in the sidebar.
 *
 * Same rule as the web sidebar: a project hosts its own cron rows when it has
 * an active agent and is expanded (a single-agent non-workflow project is
 * always expanded). Otherwise those crons fall into the ungrouped bucket so
 * they stay reachable.
 */

export function projectCanFullyCollapse(activeAgentCount: number, workflow: boolean): boolean {
  return activeAgentCount > 1 || workflow;
}

export function projectHostsScheduledTasks(input: {
  activeAgentCount: number;
  workflow: boolean;
  collapsed: boolean;
}): boolean {
  if (input.activeAgentCount === 0) return false;
  const canCollapse = projectCanFullyCollapse(input.activeAgentCount, input.workflow);
  return !input.collapsed || !canCollapse;
}

/** Session stays visible when a project or agent list is collapsed to "actionable". */
export function isSidebarSessionActionable(
  session: { id?: string } | null | undefined,
  flags: {
    activeTaskSessionIds?: Record<string, unknown>;
    changesReadyBySession?: Record<string, unknown>;
    finalizeStatusBySession?: Record<string, string>;
  },
): boolean {
  const id = session?.id;
  if (!id) return false;
  return (
    !!flags.activeTaskSessionIds?.[id] ||
    !!flags.changesReadyBySession?.[id] ||
    flags.finalizeStatusBySession?.[id] === 'ready_to_push'
  );
}
