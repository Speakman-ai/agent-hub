import { getAuthRecord } from './auth.js';

/**
 * True when a session-scoped notification belongs to a *different* signed-in
 * user and should therefore be suppressed for the current client.
 *
 * Background sessions on a shared project broadcast their `done` /
 * `awaiting_input` events to every connected client. Without this gate a user
 * sees toasts (and desktop notifications) for sessions owned by someone else,
 * and clicking through 404s because they can't open another account's session.
 *
 * This mirrors the server-side push scoping in `server/push.ts`
 * (`filterTokensForSessionOwner`): suppress ONLY when the session has a known
 * owner AND the current client is a known, *different* user. When either id is
 * missing we do NOT suppress — matching push's "null owner / local bundled
 * server ⇒ deliver to all" behaviour. Concretely we keep showing the
 * notification when:
 *   - the session is unowned (`ownerUserId` null) — cron / heartbeat /
 *     autonomous / system sessions have no owner to scope to;
 *   - the current client has no user id (local bundled single-user mode, or a
 *     legacy token issued before per-user `id` was stamped).
 *
 * @param {string|null|undefined} ownerUserId - `ownerUserId` stamped on the WS event.
 * @param {() => ({ user?: { id?: string } } | null)} [getRecord] - injectable for tests.
 * @returns {boolean} true ⇒ suppress this notification.
 */
export function isSessionOwnedByOtherUser(ownerUserId, getRecord = getAuthRecord) {
  const ownerId = ownerUserId || null;
  if (!ownerId) return false;
  const myUserId = getRecord()?.user?.id || null;
  if (!myUserId) return false;
  return ownerId !== myUserId;
}
