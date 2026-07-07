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
 *     dispatch, bug-report intake) must be attributed to the real human
 *     who triggered the work (card creator, session owner, autonomous
 *     enabler, configuring user). There is **no org-owner fallback**: when
 *     no real user can be determined the owner resolves to `null` and the
 *     calling path is expected to hard-fail rather than borrow an identity.
 *   - Child sessions (handoff target, forwarded-to-agent) inherit the
 *     parent's owner (and only the parent's owner — null stays null).
 *   - Pre-migration rows (NULL owner) are owned by nobody: they are not
 *     auto-granted to any user.
 */
import { getDb } from './db.js';
import { getUserById } from './users-store.js';
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

export type OwnerResolvable = Pick<
  AuthenticatedRequest,
  'authUserId' | 'authViaApiKey' | 'authLocalOrgBypass'
>;

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
 * Strictly the JWT-validated `req.authUserId`. There is no org-owner
 * fallback: an unauthenticated / system caller resolves to `null`, and
 * callers that need a real owner (per-account AI spawns) must hard-fail.
 */
export function resolveOwnerUserId(req: OwnerResolvable | undefined): string | null {
  return req?.authUserId ?? null;
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
 * Reads the agent id a session belongs to, or `null` if the row is missing.
 * Used to forward `agentId` on push payloads so a cold-start notification tap
 * can open the right chat before the sessions list has loaded.
 */
export function getSessionAgentId(sessionId: string): string | null {
  try {
    const row = getDb().prepare('SELECT agent_id FROM sessions WHERE id = ?').get(sessionId) as
      | { agent_id: string | null }
      | undefined;
    return row?.agent_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Copy the owner from `sourceSessionId` onto `targetSessionId`. Used
 * by handoff and forward to keep child sessions strictly inheriting.
 * Inherits only the source's recorded owner — when the source has no
 * owner, the target stays null (no org-owner fallback).
 */
export function inheritOwnerFromSession(targetSessionId: string, sourceSessionId: string): void {
  setSessionOwner(targetSessionId, getSessionOwner(sourceSessionId));
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
 * True when `sessionId` is a cron run whose parent cron is shared
 * (`crons.shared = 1`). Shared crons are visible to every org member (see
 * `canViewCron` in `routes/crons.ts` and the `/api/crons/:id/thread`
 * surface), so their run sessions are read-only artifacts anyone in the
 * org may inspect — the same treatment reviewer sessions get.
 *
 * Non-shared cron sessions return `false` here and fall through to strict
 * ownership, keeping them private to the cron owner.
 *
 * Returns `false` defensively if the join can't resolve (missing row, DB
 * not initialised in a test harness) so strict ownership applies.
 */
export function isSharedCronSession(sessionId: string): boolean {
  try {
    const row = getDb()
      .prepare(
        'SELECT c.shared AS shared FROM sessions s JOIN crons c ON s.cron_id = c.id WHERE s.id = ?',
      )
      .get(sessionId) as { shared: number | null } | undefined;
    return Boolean(row?.shared);
  } catch {
    return false;
  }
}

/**
 * Read predicate. Permissive for shared session types — reviewer sessions
 * and shared-cron run sessions. All other reads fall through to strict
 * ownership.
 *
 * Use this for GET endpoints and list filters where the goal is "show
 * everything the caller is allowed to see." Writes (POST/PUT/PATCH/
 * DELETE, plus WebSocket `chat` / `cancel`) must continue to call
 * `userOwnsSession` — visibility is broader than mutation rights.
 */
export function userCanReadSession(req: OwnerResolvable | undefined, sessionId: string): boolean {
  if (isReviewerSession(sessionId)) return true;
  if (isSharedCronSession(sessionId)) return true;
  return userOwnsSession(req, sessionId);
}

/**
 * Strict ownership predicate. NULL-owner rows belong to nobody and are
 * not auto-granted to any user — there is no org-owner grace path.
 */
export function userOwnsSession(req: OwnerResolvable | undefined, sessionId: string): boolean {
  // No auth at all (fresh install / tests) → every caller "owns" everything.
  // This mirrors `authMiddleware`'s no-auth bypass so ownership doesn't
  // gate routes that auth itself doesn't.
  if (isAuthDisabled()) return true;
  // Break-glass / single-tenant bypass. The global `x-api-key` is treated
  // as Owner for every org (see authMiddleware) and the local-bundled
  // server (Electron / dev box) runs without per-user auth — neither
  // carries a per-user `authUserId` to scope against. Mirror the
  // visibility-middleware `localBypass` (authViaApiKey || authLocalOrgBypass)
  // so session-scoped routes don't 404 these full-privilege callers under
  // strict JWT auth. Without this, an agent reading Finalize run/step-output
  // logs with the injected `x-api-key` gets "Session not found" on a
  // JWT-enabled hub because `resolveOwnerUserId` returns null.
  if (req?.authViaApiKey || req?.authLocalOrgBypass) return true;
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
  // NULL-owner rows belong to nobody — not auto-granted to any user.
  if (!owner) return false;
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
 *   3. **`epic.autonomous_enabled_by`** (or phase-level via the merged
 *      dispatch settings object) — whoever flipped autonomous on. Same
 *      validity check as `created_by`. Captures the "no card-level signal,
 *      but a human did press Run / enable auto-dispatch" case.
 *
 * Returns `null` when none of the above identifies a real user. There is
 * **no org-owner fallback**: the autonomous dispatcher must hard-fail (skip
 * the spawn and log) rather than attribute the work to a borrowed identity.
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
  // No real user → no owner. Caller hard-fails (no org-owner fallback).
  return null;
}
