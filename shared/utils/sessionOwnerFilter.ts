export const ALL_OWNERS = '__all__';

export interface SessionOwnerFields {
  ownerUserId?: string | null;
  ownerName?: string | null;
  /** Present on dashboard session rows; ignored by filter helpers. */
  sessionId?: string;
}

export interface UserOwnerFields {
  id?: string | null;
  email?: string | null;
  username?: string | null;
}

export interface OwnerOption {
  key: string;
  label: string;
  count: number;
}

export function ownerKeyForSession(session?: SessionOwnerFields | null): string {
  if (session?.ownerUserId != null && session.ownerUserId !== '') {
    return `id:${session.ownerUserId}`;
  }
  if (session?.ownerName) return `name:${session.ownerName}`;
  return '__unassigned__';
}

export function ownerKeyForUser(user: UserOwnerFields | null | undefined): string | null {
  if (!user) return null;
  if (user.id != null && user.id !== '') return `id:${user.id}`;
  if (user.email) return `name:${user.email}`;
  if (user.username) return `name:${user.username}`;
  return null;
}

export function defaultOwnerFilter(currentUserKey: string | null | undefined): string {
  return currentUserKey || ALL_OWNERS;
}

export function buildOwnerOptions(
  sessions?: SessionOwnerFields[] | null,
  {
    currentUserKey = null,
    currentUserName = null,
  }: { currentUserKey?: string | null; currentUserName?: string | null } = {},
): OwnerOption[] {
  const list = Array.isArray(sessions) ? sessions : [];
  const map = new Map<string, OwnerOption>();
  for (const s of list) {
    const key = ownerKeyForSession(s);
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { key, label: s?.ownerName || 'Unassigned', count: 1 });
  }
  if (currentUserKey && !map.has(currentUserKey)) {
    map.set(currentUserKey, { key: currentUserKey, label: currentUserName || 'You', count: 0 });
  }
  const owners = Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return [{ key: ALL_OWNERS, label: 'All users', count: list.length }, ...owners];
}

export function filterSessionsByOwner<T extends SessionOwnerFields>(
  sessions: T[] | undefined,
  ownerKey: string | null | undefined,
): T[] {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!ownerKey || ownerKey === ALL_OWNERS) return list;
  return list.filter((s) => ownerKeyForSession(s) === ownerKey);
}
