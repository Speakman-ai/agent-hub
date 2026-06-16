// Shared, framework-free owner-filtering model for the dashboard's Active
// Sessions queue. Imported by the web and mobile clients so the "filter by
// user, default to me" behaviour never drifts between surfaces.
//
// Sessions carry `ownerUserId` (the stable identity) and `ownerName` (the
// display label). We key owners by id when present and fall back to name, so
// local/single-user mode (which may not persist a user id) still groups
// correctly. Filtering is purely client-side over the already-fetched list —
// no extra API surface.

/** Sentinel filter value meaning "show every owner". */
export const ALL_OWNERS = '__all__';

/**
 * Stable owner key for a session row. `id:`/`name:` prefixes keep an id-keyed
 * owner from ever colliding with a name-keyed one.
 * @param {{ ownerUserId?: string | null, ownerName?: string | null }} [session]
 * @returns {string}
 */
export function ownerKeyForSession(session) {
  if (session && session.ownerUserId != null && session.ownerUserId !== '') {
    return `id:${session.ownerUserId}`;
  }
  if (session && session.ownerName) return `name:${session.ownerName}`;
  return '__unassigned__';
}

/**
 * Owner key for the signed-in user, matching {@link ownerKeyForSession} so a
 * user's own sessions resolve to the same bucket. Returns `null` when no user
 * identity is available (so callers fall back to {@link ALL_OWNERS}).
 * @param {{ id?: string | null, username?: string | null } | null | undefined} user
 * @returns {string | null}
 */
export function ownerKeyForUser(user) {
  if (!user) return null;
  if (user.id != null && user.id !== '') return `id:${user.id}`;
  if (user.username) return `name:${user.username}`;
  return null;
}

/**
 * The filter value to start from: the current user when known, else "all".
 * @param {string | null | undefined} currentUserKey
 * @returns {string}
 */
export function defaultOwnerFilter(currentUserKey) {
  return currentUserKey || ALL_OWNERS;
}

/**
 * Build the selectable owner options from the active-sessions list. Always
 * leads with an "All users" entry; one entry per distinct owner sorted by
 * label; counts reflect how many in-flight sessions each owns. The current
 * user is always included (count 0 if they have nothing in flight) so the
 * default "just me" selection is always a valid, visible option.
 *
 * @param {Array<{ ownerUserId?: string | null, ownerName?: string | null }>} [sessions]
 * @param {{ currentUserKey?: string | null, currentUserName?: string | null }} [opts]
 * @returns {Array<{ key: string, label: string, count: number }>}
 */
export function buildOwnerOptions(
  sessions,
  { currentUserKey = null, currentUserName = null } = {},
) {
  const list = Array.isArray(sessions) ? sessions : [];
  /** @type {Map<string, { key: string, label: string, count: number }>} */
  const map = new Map();
  for (const s of list) {
    const key = ownerKeyForSession(s);
    const existing = map.get(key);
    if (existing) existing.count += 1;
    else map.set(key, { key, label: (s && s.ownerName) || 'Unassigned', count: 1 });
  }
  if (currentUserKey && !map.has(currentUserKey)) {
    map.set(currentUserKey, { key: currentUserKey, label: currentUserName || 'You', count: 0 });
  }
  const owners = Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }),
  );
  return [{ key: ALL_OWNERS, label: 'All users', count: list.length }, ...owners];
}

/**
 * Filter the sessions to a single owner. `ALL_OWNERS` (or a falsy key) is a
 * pass-through.
 * @template {{ ownerUserId?: string | null, ownerName?: string | null }} T
 * @param {T[]} [sessions]
 * @param {string | null | undefined} ownerKey
 * @returns {T[]}
 */
export function filterSessionsByOwner(sessions, ownerKey) {
  const list = Array.isArray(sessions) ? sessions : [];
  if (!ownerKey || ownerKey === ALL_OWNERS) return list;
  return list.filter((s) => ownerKeyForSession(s) === ownerKey);
}
