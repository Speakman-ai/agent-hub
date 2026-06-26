/**
 * Remove a set of session ids from a session-id-keyed map, preserving every
 * other entry.
 *
 * Used by bulk-clear flows: clearing the sessions of one (possibly inactive,
 * expanded-in-sidebar) agent must only drop that agent's session-scoped state
 * (e.g. `browserScreensBySession`). Replacing the whole map would blank state
 * for the active chat's unrelated sessions.
 */
export function pruneSessionScopedMap<T>(
  map: Record<string, T>,
  removedIds: Iterable<string>,
): Record<string, T> {
  const remove = removedIds instanceof Set ? removedIds : new Set(removedIds);
  if (remove.size === 0) return map;
  const next: Record<string, T> = {};
  for (const key of Object.keys(map)) {
    if (!remove.has(key)) next[key] = map[key];
  }
  return next;
}
