import { api } from './api';
import { getAuthRecord } from './auth';
import type { AssignableUser } from './kanbanUserFilter';

export function resolveCurrentUserId(assignableUsers: AssignableUser[] = []): string | null {
  const rec = getAuthRecord();
  if (rec?.user?.id) return rec.user.id;
  const username = rec?.user?.username;
  if (username) {
    const match = assignableUsers.find((user) => user.username === username);
    if (match) return match.id;
  }
  if (assignableUsers.length === 1) return assignableUsers[0]!.id;
  return null;
}

export function shouldPromptLeadUserCardAssign(
  previousUserId: string | null | undefined,
  nextUserId: string | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!nextUserId || !currentUserId) return false;
  if (nextUserId !== currentUserId) return false;
  return (previousUserId || null) !== nextUserId;
}

export async function maybePromptAssignLeadToEpicCards(opts: {
  projectId: string;
  epicId: string;
  previousUserId: string | null | undefined;
  nextUserId: string | null | undefined;
  cardCount: number;
  assignableUsers?: AssignableUser[];
  confirm?: (message: string) => boolean;
}): Promise<number | null> {
  const currentUserId = resolveCurrentUserId(opts.assignableUsers || []);
  if (
    !shouldPromptLeadUserCardAssign(opts.previousUserId, opts.nextUserId, currentUserId) ||
    opts.cardCount <= 0
  ) {
    return null;
  }

  const confirm = opts.confirm ?? ((message: string) => window.confirm(message));
  const noun = opts.cardCount === 1 ? 'card' : 'cards';
  if (
    !confirm(
      `You're the lead on this epic. Assign yourself as lead user on all ${opts.cardCount} ${noun}?`,
    )
  ) {
    return null;
  }

  const result = await api.assignEpicLeadToCards(opts.projectId, opts.epicId);
  return typeof result?.updatedCount === 'number' ? result.updatedCount : null;
}
