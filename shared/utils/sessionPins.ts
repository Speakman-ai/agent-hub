export function isSessionPinned(session: object | null | undefined): boolean {
  const pinnedAt = (session as { pinned_at?: unknown } | null | undefined)?.pinned_at;
  return typeof pinnedAt === 'string' && pinnedAt.length > 0;
}

/** SQLite `datetime('now')` has no zone marker but is UTC; ISO strings parse as-is. */
function activityMs(session: object): number {
  const raw = (session as { updated_at?: unknown }).updated_at;
  if (typeof raw !== 'string' || !raw) return NaN;
  const iso = /[T]/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/**
 * Pinned sessions first, each group newest activity first. The server already
 * orders the list this way, but a live pin toggle patches a row in place, so
 * the client re-derives the order on render rather than trusting array order.
 * When any row lacks a parseable `updated_at` the groups keep incoming order.
 */
export function pinnedSessionsFirst<T extends object>(sessions: T[]): T[] {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const s of sessions) (isSessionPinned(s) ? pinned : rest).push(s);
  if (sessions.every((s) => !Number.isNaN(activityMs(s)))) {
    const byRecency = (a: T, b: T) => activityMs(b) - activityMs(a);
    pinned.sort(byRecency);
    rest.sort(byRecency);
  }
  const next = [...pinned, ...rest];
  return next.every((s, i) => s === sessions[i]) ? sessions : next;
}
