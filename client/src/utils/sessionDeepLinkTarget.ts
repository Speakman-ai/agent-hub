/**
 * Resolve which session to select when the sessions list for an agent loads.
 *
 * Background: the sidebar list endpoint (`GET /api/agents/:agentId/sessions`)
 * is deliberately owner-only, so a session the caller does not own (e.g. an
 * org admin clicking another user's row in the dashboard Active-sessions
 * panel) is absent from `data`. The server still lets an admin READ that
 * session by id via the permissive gate on `/api/sessions/:sessionId`.
 *
 * This helper keeps the target-resolution logic pure and testable. It returns
 * the best owned-session fallback plus, when a deep-link target is requested
 * but missing from the owned list, the id the caller should fetch directly.
 */
export interface MinimalSessionRow {
  id: string;
  [key: string]: unknown;
}

export interface DeepLinkTargetResult<T extends MinimalSessionRow> {
  /**
   * The owned session to select when no direct fetch is needed (or the
   * fallback to use if the direct fetch is denied). May be null when the
   * caller has no sessions for this agent.
   */
  target: T | null;
  /**
   * When set, the caller was deep-linked to a session that is not in the
   * owned list. The caller should fetch it by id and, on success, select it
   * instead of `target` (which stays as the graceful fallback).
   */
  deepLinkFetchId: string | null;
}

export function resolveDeepLinkTarget<T extends MinimalSessionRow>(
  data: T[],
  targetSessionId: string | null | undefined,
  remembered: T | null | undefined,
): DeepLinkTargetResult<T> {
  const list = Array.isArray(data) ? data : [];
  const fallback = remembered ?? list[0] ?? null;
  if (targetSessionId) {
    const owned = list.find((s) => s.id === targetSessionId) ?? null;
    if (owned) return { target: owned, deepLinkFetchId: null };
    // Requested a specific session that the owner-only list doesn't carry.
    // Signal a direct fetch rather than silently snapping to `fallback`.
    return { target: fallback, deepLinkFetchId: targetSessionId };
  }
  return { target: fallback, deepLinkFetchId: null };
}

/**
 * Insert or replace a session row by id, keeping the rest of the list order
 * stable. Used to merge a directly-fetched deep-linked session into the
 * in-memory list so downstream `sessions.find(...)` lookups resolve its
 * engine/model/name for the read-only view.
 */
export function upsertSessionRow<T extends MinimalSessionRow>(list: T[], row: T): T[] {
  const arr = Array.isArray(list) ? list : [];
  const idx = arr.findIndex((s) => s.id === row.id);
  if (idx === -1) return [row, ...arr];
  const next = arr.slice();
  next[idx] = row;
  return next;
}
