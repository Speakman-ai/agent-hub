/**
 * Resolve which Hub user a `/api/google/*` proxy call should run as.
 *
 * The Google connection (OAuth tokens) is keyed by Hub user id in
 * `google-connections-store.ts`. The data-proxy routes are USER-scoped, so the
 * acting user decides whose calendar / mail / sheets the call touches. Three
 * cases, mirroring the AWS SSO probe attribution (`aws-sso-caller-identity.ts`)
 * and kanban card linking:
 *
 *   1. `authUserId` present — a JWT user, a per-user `ahub_*` key, or a
 *      server-minted `spawn:<id>` key (whose owner the auth layer resolves to
 *      `authUserId`). The caller IS that user; use their connection.
 *   2. Break-glass global `x-api-key` (no `authUserId`) carrying a session
 *      context — attribute the call to the **owning user of that session**. An
 *      in-Hub agent spawn must read/write Google scoped to the SESSION OWNER
 *      (the human who linked their Google account), never a shared/global one.
 *      Without this, an agent on the global key resolves to the synthetic
 *      single-tenant user and would miss (or cross) the real owner's tokens.
 *   3. Otherwise — fall back to the provider-agnostic single-tenant resolver
 *      (`local-<orgId>` synthetic user for Electron/local-bypass, else null).
 *
 * SECURITY — session-source precedence:
 *   The `X-Agent-Hub-Session-Id` header is attacker-controllable (anyone with
 *   the global `x-api-key`). The cryptographically bound `authSpawnSessionId`
 *   (derived from a server-minted `spawn:<id>` key) is NOT. We resolve the
 *   bound id FIRST and only consult the raw header when no bound id exists, so
 *   a spawn-authenticated caller can never redirect the call to another
 *   session owner's connection via the header. A holder of the global key
 *   already has Owner privilege over every org, so the header path is not a
 *   privilege escalation — it only keeps attribution correct for break-glass
 *   CLI scripts that pass the session id explicitly.
 */
import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { AGENT_HUB_SESSION_ID_HEADER } from './kanban-caller-session.js';
import { resolveOAuthConnectionUserId } from './github-connection-user.js';
import type { SessionRow } from './types.js';

export interface GoogleConnectionUserContext {
  /** Prepared statement that resolves a session id to its row. */
  getSession?: { get(id: string): unknown };
}

export function resolveGoogleConnectionUserId(
  req: Request,
  ctx?: GoogleConnectionUserContext | null,
): string | null {
  const authed = req as AuthenticatedRequest;

  // 1. Per-user identity (JWT, ahub_* key, or bound spawn:<id> key).
  const authUserId = authed.authUserId;
  if (typeof authUserId === 'string' && authUserId.trim()) {
    return authUserId.trim();
  }

  // 2. Break-glass with a session context → attribute to the session owner.
  if (ctx?.getSession) {
    const headerId = req.get(AGENT_HUB_SESSION_ID_HEADER) ?? req.get('X-Agent-Hub-Session-Id');
    const sessionId =
      (authed.authSpawnSessionId && authed.authSpawnSessionId.trim()) ||
      (headerId && headerId.trim()) ||
      '';
    if (sessionId) {
      const session = ctx.getSession.get(sessionId) as SessionRow | undefined;
      const owner = session?.owner_user_id;
      if (typeof owner === 'string' && owner.trim()) {
        return owner.trim();
      }
    }
  }

  // 3. Single-tenant synthetic user (local bypass) or null.
  return resolveOAuthConnectionUserId(req);
}
