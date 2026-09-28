/**
 * State updates for a discarded session. Run on the `changes_discarded`
 * broadcast and directly after a local Discard succeeds, so the sidebar
 * stops pinning the session as actionable without waiting for the socket.
 */

export function withoutChangesReady<T extends Record<string, unknown>>(
  changesReady: T,
  sessionId: string,
): T {
  if (!changesReady[sessionId]) return changesReady;
  const next = { ...changesReady };
  delete next[sessionId];
  return next;
}

export function markSessionDiscarded<S extends { id: string }>(
  sessions: S[],
  sessionId: string,
  discardedAt: string | null,
): S[] {
  let changed = false;
  const next = sessions.map((s) => {
    if (s.id !== sessionId) return s;
    changed = true;
    return { ...s, changes_ready: null, discarded_at: discardedAt };
  });
  return changed ? next : sessions;
}
