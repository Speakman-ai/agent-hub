export interface NotificationProjectScopeOpts {
  localBypass?: boolean;
}

export interface NotificationAgentRef {
  id: string;
  projectId?: string;
}

export interface NotificationProjectRef {
  id: string;
  ownerUserId?: string | null;
}

export function shouldNotifyUserForProject(
  projectOwnerUserId: string | null | undefined,
  currentUserId: string | null | undefined,
  opts: NotificationProjectScopeOpts = {},
): boolean {
  if (opts.localBypass) return true;
  const owner =
    typeof projectOwnerUserId === 'string' && projectOwnerUserId ? projectOwnerUserId : null;
  if (!owner) return true;
  const me = typeof currentUserId === 'string' && currentUserId ? currentUserId : null;
  return owner === me;
}

export function resolveNotificationProjectId(
  data: Record<string, unknown> | null | undefined,
  agents: NotificationAgentRef[] = [],
): string | null {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.projectId === 'string' && data.projectId) return data.projectId;
  if (typeof data.agentId === 'string' && data.agentId) {
    const agent = agents.find((a) => a.id === data.agentId);
    return typeof agent?.projectId === 'string' && agent.projectId ? agent.projectId : null;
  }
  return null;
}

export function shouldDeliverProjectNotification(
  data: Record<string, unknown> | null | undefined,
  currentUserId: string | null | undefined,
  projects: NotificationProjectRef[] = [],
  agents: NotificationAgentRef[] = [],
  opts: NotificationProjectScopeOpts = {},
): boolean {
  const projectId = resolveNotificationProjectId(data, agents);
  if (!projectId) return true;
  const project = projects.find((p) => p.id === projectId);
  if (!project) return true;
  return shouldNotifyUserForProject(project.ownerUserId, currentUserId, opts);
}
