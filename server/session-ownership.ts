/**
 * Per-user session ownership (Phase 4).
 *
 * Sessions live in the per-org `agent-hub.db` while users live in the
 * shared `orgs.db`. We can't enforce a SQLite foreign key across the
 * two databases, so `sessions.owner_user_id` is a logical reference
 * stored as plain TEXT.
 *
 * Ownership rules implemented here:
 *   - Strictly private: only the creator's user id may read/mutate the row.
 *   - System-spawned sessions (cron, heartbeats, webhooks, autonomous
 *     dispatch, bug-report intake) are owned by the org owner — the
 *     "first" user as ordered by `users.created_at ASC`.
 *   - Local bundled mode (Electron / dev box) bypasses JWT auth and
 *     does not populate `req.authUserId`; we resolve the caller to the
 *     org owner for ownership purposes so a single-tenant install
 *     keeps working.
 *   - Child sessions (handoff target, forwarded-to-agent) inherit the
 *     parent's owner.
 *   - Pre-migration rows (NULL owner) are treated as owned by the org
 *     owner so an upgrade doesn't lose access.
 */
import { getDb } from './db.js';
import { listUsers } from './users-store.js';
import config from './config.js';
import { getAuthRecord } from './auth-store.js';
import type { AuthenticatedRequest } from './auth.js';

/**
 * True when neither an apiKey nor an auth record (JWT setup) is
 * configured — i.e. the server is in fully-open mode (fresh install,
 * tests). In that mode there's no caller identity to enforce against,
 * so ownership checks must be permissive.
 */
function isAuthDisabled(): boolean {
  if (config.apiKey) return false;
  return !getAuthRecord();
}

let cachedOrgOwnerId: string | null | undefined = undefined;

/**
 * Returns the id of the oldest user in `orgs.db.users`, or `null` if
 * the orgs db isn't initialized yet (tests / mid-boot) or there are
 * no users at all (truly fresh install).
 *
 * Caching: only **positive** lookups are cached. We never memoise
 * `null`, because the most common path that sees `null` is "boot ran
 * before the first user was created" (e.g. fresh self-hosted install
 * with no `AGENT_HUB_DEFAULT_PASSWORD`). If we cached the negative
 * lookup, a later `/api/auth/setup` would create the first user but
 * `getOrgOwnerUserId()` would keep returning `null` until the next
 * process restart — which means every system-spawned session (cron,
 * webhook reviewer, autonomous dispatch, bug-report intake) would
 * have `owner_user_id` written as NULL via `setSessionOwner`'s
 * null-guard, and the actual owner would lose access to those rows
 * in strict mode. See PR #709 review for the full reproduction.
 *
 * Tests can still call `resetOrgOwnerCache()` between fixtures to
 * force a re-lookup after seeding/dropping users.
 */
export function getOrgOwnerUserId(): string | null {
  if (typeof cachedOrgOwnerId === 'string') return cachedOrgOwnerId;
  try {
    const users = listUsers();
    if (users.length > 0) {
      cachedOrgOwnerId = users[0]!.id;
      return cachedOrgOwnerId;
    }
    // No users yet — keep `cachedOrgOwnerId` as `undefined` so the
    // next call re-resolves. listUsers() is a single-row PK lookup;
    // re-running it on every system spawn is cheap.
    return null;
  } catch {
    // orgs.db not initialized — same story: don't cache, retry next
    // call once the db is up.
    return null;
  }
}

export function resetOrgOwnerCache(): void {
  cachedOrgOwnerId = undefined;
}

export type OwnerResolvable = Pick<AuthenticatedRequest, 'authUserId'>;

/**
 * Shape of a WebSocket client carrying an optional `_authUserId` stamp
 * set by `websocket.ts` after a successful JWT handshake. Centralised
 * so callers don't repeat the structural cast `(ws as {_authUserId?:
 * string})._authUserId` and we can rename the field in one place.
 */
export interface AuthStampedWs {
  _authUserId?: string;
}

/** Set the resolved user id on a WebSocket client. No-op when `userId` is empty. */
export function setWsAuthUserId(ws: AuthStampedWs, userId: string | undefined): void {
  if (userId) ws._authUserId = userId;
}

/** Read the auth-stamped user id from a WebSocket client, if any. */
export function getWsAuthUserId(ws: AuthStampedWs | null | undefined): string | undefined {
  return ws?._authUserId;
}

/**
 * Resolve the user id that should be recorded as the owner of any
 * session this request creates, or used to gate an ownership check.
 *
 * Order:
 *   1. `req.authUserId` — set by the auth middleware on JWT-validated
 *      requests.
 *   2. Org owner — for local bundled mode (Electron / dev box) and
 *      legacy apiKey callers, both of which lack a per-user identity.
 *   3. `null` — no auth at all (pre-setup, tests).
 */
export function resolveOwnerUserId(req: OwnerResolvable | undefined): string | null {
  if (req?.authUserId) return req.authUserId;
  return getOrgOwnerUserId();
}

/** Persist `owner_user_id` on a previously-created sessions row. No-op on null. */
export function setSessionOwner(sessionId: string, ownerId: string | null): void {
  if (!ownerId) return;
  try {
    getDb().prepare('UPDATE sessions SET owner_user_id = ? WHERE id = ?').run(ownerId, sessionId);
  } catch (err) {
    // db not initialized in some unit-test harnesses — non-fatal.
    // Warn loudly because a misconfigured production DB silently
    // dropping owner writes would let strict-mode reject the actual
    // creator (see PR #709 review).
    console.warn(
      `[session-ownership] setSessionOwner(${sessionId}) failed: ${(err as Error).message}`,
    );
  }
}

/** Reads the recorded owner of a session, or `null` if the row is missing or the column is NULL. */
export function getSessionOwner(sessionId: string): string | null {
  try {
    const row = getDb()
      .prepare('SELECT owner_user_id FROM sessions WHERE id = ?')
      .get(sessionId) as { owner_user_id: string | null } | undefined;
    return row?.owner_user_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Copy the owner from `sourceSessionId` onto `targetSessionId`. Used
 * by handoff and forward to keep child sessions strictly inheriting.
 * Falls back to the org owner when the source has no recorded owner
 * (pre-migration row).
 */
export function inheritOwnerFromSession(targetSessionId: string, sourceSessionId: string): void {
  const ownerId = getSessionOwner(sourceSessionId) || getOrgOwnerUserId();
  setSessionOwner(targetSessionId, ownerId);
}

/**
 * Strict ownership predicate. NULL-owner rows are treated as belonging
 * to the org owner — this is the post-migration grace path so legacy
 * sessions in a single-tenant install stay accessible to the owner.
 */
export function userOwnsSession(req: OwnerResolvable | undefined, sessionId: string): boolean {
  // No auth at all (fresh install / tests) → every caller "owns" everything.
  // This mirrors `authMiddleware`'s no-auth bypass so ownership doesn't
  // gate routes that auth itself doesn't.
  if (isAuthDisabled()) return true;
  const owner = getSessionOwner(sessionId);
  const callerId = resolveOwnerUserId(req);
  if (!callerId) return false;
  if (!owner) {
    // Pre-migration NULL → owned by the org owner.
    return callerId === getOrgOwnerUserId();
  }
  return callerId === owner;
}

/**
 * Bulk backfill for legacy sessions whose `owner_user_id` is still
 * NULL after the schema migration. Sets every NULL row to the oldest
 * user (the org owner). No-op when there are no users yet (fresh
 * install — setup will create the first owner via `/api/auth/setup`).
 */
export function backfillSessionOwners(): { updated: number } {
  const ownerId = getOrgOwnerUserId();
  if (!ownerId) return { updated: 0 };
  try {
    const info = getDb()
      .prepare('UPDATE sessions SET owner_user_id = ? WHERE owner_user_id IS NULL')
      .run(ownerId);
    return { updated: info.changes };
  } catch {
    return { updated: 0 };
  }
}
