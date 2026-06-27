import { listMembersForOrg } from './memberships-store.js';

export type AssignableUser = { id: string; username: string };

export function loadAssignableUsers(orgId: string | null | undefined): AssignableUser[] {
  const resolvedOrgId = orgId?.trim();
  if (!resolvedOrgId) return [];
  try {
    return listMembersForOrg(resolvedOrgId).map((m) => ({
      id: m.userId,
      username: m.username,
    }));
  } catch {
    return [];
  }
}

export function normalizeAssignedUserId(
  raw: string | null | undefined,
  assignable: AssignableUser[],
): string | null | 'invalid' {
  if (raw === undefined) return null;
  if (raw == null || String(raw).trim() === '') return null;
  const id = String(raw).trim();
  if (!assignable.some((u) => u.id === id)) return 'invalid';
  return id;
}
