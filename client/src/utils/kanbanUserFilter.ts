export type AssignableUser = { id: string; username: string };

export function usernameForUserId(
  users: AssignableUser[],
  userId: string | null | undefined,
): string | null {
  if (!userId) return null;
  return users.find((u) => u.id === userId)?.username ?? null;
}

export function cardMatchesUserFilter(
  card: { assigned_user_id?: string | null },
  selectedUserIds: Set<string>,
): boolean {
  if (selectedUserIds.size === 0) return true;
  if (!card.assigned_user_id) return false;
  return selectedUserIds.has(card.assigned_user_id);
}

export function epicMatchesUserFilter(
  epic: { assigned_user_id?: string | null },
  selectedUserIds: Set<string>,
): boolean {
  if (selectedUserIds.size === 0) return true;
  if (!epic.assigned_user_id) return false;
  return selectedUserIds.has(epic.assigned_user_id);
}

export function collectAssignedUserIds(
  rows: Array<{ assigned_user_id?: string | null }>,
): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.assigned_user_id) ids.add(row.assigned_user_id);
  }
  return [...ids];
}
