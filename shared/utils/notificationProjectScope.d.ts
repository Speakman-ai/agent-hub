export interface NotifyScopeOptions {
  /** Local single-user bundled server bypass — always deliver. */
  localBypass?: boolean;
}

export function shouldNotifyUserForProject(
  projectOwnerUserId: string | null | undefined,
  currentUserId: string | null | undefined,
  opts?: NotifyScopeOptions,
): boolean;

export function resolveNotificationProjectId(
  data: Record<string, unknown> | null | undefined,
  agents?: Array<{ id: string; projectId?: string }>,
): string | null;

export function shouldDeliverProjectNotification(
  data: Record<string, unknown> | null | undefined,
  currentUserId: string | null | undefined,
  projects?: Array<{ id: string; ownerUserId?: string | null }>,
  agents?: Array<{ id: string; projectId?: string }>,
  opts?: NotifyScopeOptions,
): boolean;
