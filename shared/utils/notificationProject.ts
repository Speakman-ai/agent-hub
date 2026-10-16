import type { InboxNotification } from './notificationInbox';

export interface ProjectNameSource {
  id: string;
  name?: string | null;
}

/**
 * The project label shown on a notification row: the project's display name,
 * falling back to its id when the project isn't in the caller's list (deleted,
 * or not loaded yet). Null when the notification isn't tied to a project.
 */
export function notificationProjectName(
  n: Pick<InboxNotification, 'projectId' | 'data'>,
  projects: readonly ProjectNameSource[] | null | undefined,
): string | null {
  const fromData = n.data?.projectId;
  const projectId = n.projectId || (typeof fromData === 'string' && fromData ? fromData : null);
  if (!projectId) return null;
  const project = projects?.find((p) => p?.id === projectId);
  const name = typeof project?.name === 'string' ? project.name.trim() : '';
  return name || projectId;
}
