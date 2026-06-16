/**
 * recent-pusher.ts — correlate a smart-HTTP `git-receive-pack` request's
 * authenticated user to the project's post-receive `onPush` notification.
 *
 * Why this exists: the bare repo's post-receive hook calls back into the
 * Hub with the per-repo shared secret and **no user identity** (see
 * `smart-http.ts` notify handler). The only place the pushing Hub user is
 * known is the earlier authenticated `git-receive-pack` POST. We stash the
 * caller there and read it when the hook-fired `onPush` runs, so downstream
 * reactions (external-push auto-review) can run as the user who actually
 * pushed — their reviewer engine/model + per-account credentials.
 *
 * Correlation safety (the hard part). There is no shared key between a
 * `receive-pack` request and its later notify other than the project id, so
 * naive "remember the last pusher per project" cross-attributes under
 * concurrency: if user A and user B push the same repo at overlapping times,
 * a single-slot store would hand A's notify whichever user was written last.
 * Because this decides session ownership and which per-account credentials
 * the reviewer CLI spawns under, mis-attribution is a real security concern.
 *
 * The fix: track every in-flight `receive-pack` as its own entry, scoped to
 * the lifetime of that request (released when the request ends; a TTL is a
 * backstop for requests that never close cleanly). A notify only attributes
 * when the in-flight set is **unambiguous** — exactly one distinct, non-null
 * user is pushing that project right now. Any concurrency (two distinct
 * users, or an anonymous/break-glass push overlapping a user push) makes the
 * set ambiguous and attribution is **declined** (null → the userless
 * one-shot fallback). The common single-push case still attributes; we never
 * cross-attribute one user's push to another.
 */

/**
 * Backstop expiry (ms). Entries are normally removed when their
 * `receive-pack` request ends (see {@link releasePusher}); this only bounds
 * leakage from a request that never emits a close event.
 */
export const RECENT_PUSHER_TTL_MS = 5 * 60 * 1000;

interface PusherEntry {
  /** Unique per `recordPusher` call so a request releases exactly its own entry. */
  token: number;
  /** Authenticated user, or null for an anonymous / break-glass push. */
  userId: string | null;
  at: number;
}

/** projectId → in-flight receive-pack entries. */
const inflight = new Map<string, PusherEntry[]>();

let tokenSeq = 0;

function prune(list: PusherEntry[], now: number): PusherEntry[] {
  return list.filter((e) => now - e.at <= RECENT_PUSHER_TTL_MS);
}

/**
 * Mark a `git-receive-pack` request as in flight for a project and return an
 * opaque token. The caller MUST pass that token to {@link releasePusher}
 * when the request ends so the entry doesn't linger and make later pushes
 * look ambiguous. Anonymous / break-glass pushes (null userId) are recorded
 * too — they participate in ambiguity detection so a user push overlapping
 * an anonymous one is never mis-attributed to the user.
 */
export function recordPusher(
  projectId: string,
  userId: string | null | undefined,
  now: number = Date.now(),
): number {
  const token = ++tokenSeq;
  if (!projectId) return token;
  const list = prune(inflight.get(projectId) ?? [], now);
  list.push({ token, userId: userId ?? null, at: now });
  inflight.set(projectId, list);
  return token;
}

/** Remove the entry created by a {@link recordPusher} call (idempotent). */
export function releasePusher(projectId: string, token: number, now: number = Date.now()): void {
  const list = inflight.get(projectId);
  if (!list) return;
  const next = prune(
    list.filter((e) => e.token !== token),
    now,
  );
  if (next.length) inflight.set(projectId, next);
  else inflight.delete(projectId);
}

/**
 * Resolve the user to attribute a post-receive notification to. Returns a
 * userId only when exactly one distinct, non-null user has a `receive-pack`
 * in flight for the project; returns null when nothing is in flight, when
 * the set is ambiguous (more than one distinct user, or an overlapping
 * anonymous push), or when the only in-flight push is anonymous. Read-only:
 * entries are removed by {@link releasePusher} (request end) / TTL, not here,
 * so a single push that emits more than one notify stays consistent.
 */
export function takeRecentPusher(projectId: string, now: number = Date.now()): string | null {
  const list = inflight.get(projectId);
  if (!list) return null;
  const live = prune(list, now);
  if (live.length !== list.length) {
    if (live.length) inflight.set(projectId, live);
    else inflight.delete(projectId);
  }
  if (!live.length) return null;
  const distinct = new Set(live.map((e) => e.userId));
  // Exactly one distinct identity in flight, and it's a real user → safe.
  if (distinct.size === 1 && live[0].userId != null) return live[0].userId;
  // Zero candidates already handled; here it's ambiguous or anonymous-only.
  return null;
}

/** Test seam. */
export function __clearRecentPushers(): void {
  inflight.clear();
}
