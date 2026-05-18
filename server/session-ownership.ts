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
import { listUsers, getUserById } from './users-store.js';
import config from './config.js';
import { getAuthRecord } from './auth-store.js';
import { findAgent } from './project-model.js';
import type { AuthenticatedRequest } from './auth.js';
import type { Role } from './roles.js';

/**
 * True when `id` looks like a real user row in orgs.db. Used by the
 * autonomous owner-resolution chain to drop free-form `created_by`
 * values (agent ids, "system", legacy strings) so they don't end up
 * stamped as `owner_user_id` and silently lock the actual operator out
 * of their own sessions.
 *
 * Errors from `getUserById` (orgs.db not initialized in mid-boot / test
 * harness) collapse to `false` — the caller falls through to the next
 * resolution step rather than crash.
 */
function isKnownUserId(id: string | null | undefined): id is string {
  if (!id) return false;
  try {
    return getUserById(id) != null;
  } catch {
    return false;
  }
}

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
 * Snapshot of a WebSocket caller's visibility context. Mirrors the
 * `VisibilityCaller` shape used by REST routes (see
 * `project-visibility-middleware.ts#resolveVisibilityCaller`) so the
 * broadcast filter in `websocket.ts` can reuse `canViewProject` without
 * re-deriving caller state on every fan-out.
 *
 * Kept as a structural type (not a direct import of `VisibilityCaller`)
 * so this module stays free of dependency on the visibility layer; the
 * websocket layer is the only call site that binds the two together.
 */
export interface WsVisibilityStamp {
  userId: string | null;
  role?: Role;
  /**
   * True for callers with no privacy boundary — single-tenant local
   * bundled server, the global `x-api-key` break-glass, or the "no auth
   * configured" mode. These callers see every broadcast.
   */
  localBypass?: boolean;
}

/**
 * Shape of a WebSocket client carrying optional auth stamps set by
 * `websocket.ts` after a successful handshake.
 *
 * `_authUserId` is the per-session user attribution used by
 * `userOwnsSession` and `createSession`. `_authVisibility` is a richer
 * snapshot used by `broadcast()` to filter events on private projects.
 *
 * Centralised so callers don't repeat structural casts and we can rename
 * fields in one place.
 */
export interface AuthStampedWs {
  _authUserId?: string;
  _authVisibility?: WsVisibilityStamp;
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
 * Stamp the visibility snapshot used by `broadcast()` to skip events on
 * private projects the caller cannot view. Idempotent — safe to call
 * once at handshake time even when `stamp.userId` is null (e.g. a no-auth
 * test harness), because the stamp still carries `localBypass`.
 */
export function setWsAuthVisibility(ws: AuthStampedWs, stamp: WsVisibilityStamp): void {
  ws._authVisibility = stamp;
}

/** Read the auth-stamped visibility snapshot, if any. */
export function getWsAuthVisibility(
  ws: AuthStampedWs | null | undefined,
): WsVisibilityStamp | undefined {
  return ws?._authVisibility;
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
 * Resolve the user id whose **per-account CLI credentials** (Anthropic
 * OAuth token / API key, Cursor / Gemini / Codex keys) should flow into
 * a session's spawn env.
 *
 * Precedence:
 *   1. **`persistedOwnerId`** — the value `getSessionOwner` returned for
 *      this session. Caller does the lookup so chat.ts can reuse the
 *      single up-front read it already makes for hooks / MCP / GitHub
 *      branches.
 *   2. **Org owner** — reviewer sessions and other system spawns leave
 *      `owner_user_id` NULL so the thread stays shared/read-only across
 *      the org. For CLI billing purposes that's the wrong signal: the
 *      shared host subscription gets hammered while the operator's
 *      per-account quota sits idle. Falling back to the org owner means
 *      the human who configured per-account creds in Settings actually
 *      pays for the reviewer's tokens, instead of every reviewer dispatch
 *      sharing one limit.
 *   3. **`null`** — no users in the install yet (pre-`/api/auth/setup`).
 *
 * **Billing-only**: this resolver is NOT a substitute for `getSessionOwner`.
 * Identity-bearing decisions (GitHub token attribution, per-session
 * ownership writes, per-user MCP / skill credential injection) must
 * continue to gate on the persisted owner, never on this fallback.
 *
 * Mirrors the `getSessionOwner() || getOrgOwnerUserId()` chain
 * `auto-git.ts:resolveAutoGitGithubToken` uses for GitHub PR-push
 * tokens; the two chains live in different files because their guard
 * conditions diverge (GitHub has reviewer identity-isolation rules
 * that don't apply to CLI billing).
 */
export function resolveSpawnCredsOwnerUserId(
  persistedOwnerId: string | null | undefined,
): string | null {
  if (persistedOwnerId) return persistedOwnerId;
  try {
    return getOrgOwnerUserId();
  } catch {
    return null;
  }
}

/**
 * Reviewer sessions are spawned by the GitHub webhook handler when a PR
 * opens or syncs (see `runReviewerDispatch` in `server/routes/webhooks.ts`).
 * They are shared across all users in the org: the review thread is a
 * read-only artifact that anyone with access to the project should be
 * able to inspect. We detect them by resolving the session's `agent_id`
 * through the project config and checking `agent.role === 'reviewer'`.
 *
 * Returns `false` defensively if the session row, the agent lookup, or
 * the project model is not available (e.g. mid-boot, test harness
 * without project-model initialised) — strict ownership then applies.
 */
export function isReviewerSession(sessionId: string): boolean {
  try {
    const row = getDb().prepare('SELECT agent_id FROM sessions WHERE id = ?').get(sessionId) as
      | { agent_id?: string }
      | undefined;
    if (!row?.agent_id) return false;
    const lookup = findAgent(row.agent_id);
    return lookup?.agent?.role === 'reviewer';
  } catch {
    return false;
  }
}

/**
 * Read predicate. Permissive for shared session types (currently only
 * reviewer sessions). All other reads fall through to strict ownership.
 *
 * Use this for GET endpoints and list filters where the goal is "show
 * everything the caller is allowed to see." Writes (POST/PUT/PATCH/
 * DELETE, plus WebSocket `chat` / `cancel`) must continue to call
 * `userOwnsSession` — visibility is broader than mutation rights.
 */
export function userCanReadSession(req: OwnerResolvable | undefined, sessionId: string): boolean {
  if (isReviewerSession(sessionId)) return true;
  return userOwnsSession(req, sessionId);
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
  // apiKey-only legacy mode: an `apiKey` is configured but per-user JWT
  // auth has never been set up (`auth.json` does not exist and the
  // `users` table is empty). The apiKey middleware already authorized
  // this caller and stamped them as `Owner`; with no per-user identity
  // model in place there is nobody to scope ownership against, so
  // ownership must be permissive. Without this branch every
  // `/api/sessions/:sessionId/*` request 404s on prod installs that
  // upgraded from the apiKey-only era: `resolveOwnerUserId` returns
  // null (no users) and the `if (!callerId)` path below rejects the
  // call. Once `/api/auth/setup` runs, `getAuthRecord()` is non-null
  // and we fall through to strict enforcement.
  if (!getAuthRecord()) return true;
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
 * Resolve the user id that should own a session spawned by the
 * autonomous dispatcher (and any sibling system-spawn path that wants
 * the same semantics — crons, heartbeats, webhook reviewers). The
 * dispatcher has no `req` to read `authUserId` off of, so we walk a
 * series of progressively-weaker signals to find the human responsible:
 *
 *   1. **`card.created_by`** — the user who filed the ticket. We only
 *      accept it when it matches a real user row, because the
 *      `POST /board/cards` endpoint currently accepts the field as
 *      free-form text from the body (intake agents stamp their own
 *      `agent.id`, for example), and writing a non-user string into
 *      `owner_user_id` would lock everyone out under strict-mode auth.
 *   2. **`card.session_id` owner** — the chat session that filed the
 *      card. Useful when the ticket came in via a chat thread that
 *      doesn't write `created_by` (e.g. the user typed the ticket in
 *      free-form and the agent created it under its own session).
 *   3. **`epic.autonomous_enabled_by`** — whoever flipped
 *      `epic.autonomous = 1`. Same validity check as `created_by`.
 *      Captures the "no card-level signal, but a human did press the
 *      autonomous switch" case.
 *   4. **`getOrgOwnerUserId()`** — last-resort fallback so a fresh
 *      install / legacy data still produces a non-null owner.
 *
 * Returns `null` only when no users exist yet (pre-`/api/auth/setup`,
 * tests) — `setSessionOwner` is a no-op on null, matching the previous
 * behaviour where the column stayed NULL until backfill ran.
 */
export function resolveAutonomousOwnerUserId(
  card: { created_by?: string | null; session_id?: string | null } | null | undefined,
  epic: { autonomous_enabled_by?: string | null } | null | undefined,
): string | null {
  // 1. Card creator — if it points at a real user row.
  if (card?.created_by && isKnownUserId(card.created_by)) {
    return card.created_by;
  }
  // 2. Owner of the session that filed the card.
  if (card?.session_id) {
    const sessionOwner = getSessionOwner(card.session_id);
    if (sessionOwner && isKnownUserId(sessionOwner)) return sessionOwner;
  }
  // 3. Whoever flipped autonomous = 1 on the epic.
  if (epic?.autonomous_enabled_by && isKnownUserId(epic.autonomous_enabled_by)) {
    return epic.autonomous_enabled_by;
  }
  // 4. Org owner fallback.
  return getOrgOwnerUserId();
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
