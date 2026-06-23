/**
 * Resolve which Hub user an AWS SSO probe (`/aws-sso/status`, `/aws-sso/login`)
 * should run as.
 *
 * The AWS CLI keys its SSO **token cache** off `$HOME/.aws/sso/cache`, and
 * Agent Hub pins HOME per acting user (`buildSpawnEnv`). So the identity that
 * owns the probe decides which token cache it can read:
 *
 *   1. `authUserId` present — a JWT user or per-user `ahub_*` key (including a
 *      `spawn:<id>` key, which sets `authUserId` to the key's owner). The
 *      caller IS that user; probe their per-user HOME.
 *   2. Break-glass `x-api-key` (no `authUserId`) carrying a session context:
 *      attribute the probe to the **owning user of that session** — BUT only
 *      after binding the session to the project in the request path. An in-Hub
 *      agent spawn runs under its session owner's per-user HOME, which is
 *      exactly where the human's web `aws sso login` wrote the SSO token.
 *      Without this, the agent's break-glass status probe runs under the shared
 *      host HOME, never sees the per-user token, and reports `loggedIn: false`
 *      while the user is in fact logged in (the "AWS probe always returns
 *      false" bug).
 *   3. Otherwise null — pure operator break-glass with no (valid, in-project)
 *      session context; probe the shared host HOME (unchanged legacy behavior).
 *
 * SECURITY — session-source precedence and project binding:
 *
 *   - The `X-Agent-Hub-Session-Id` header is attacker-controllable (anyone
 *     holding the global `x-api-key` can set any value). The cryptographically
 *     bound `authSpawnSessionId` (derived by the auth layer from a server-minted
 *     `spawn:<id>` key) is NOT. So we resolve `authSpawnSessionId` FIRST and
 *     only consult the raw header when no bound spawn-session id exists. We do
 *     NOT delegate this to the generic `resolveCardSessionId`, which prefers the
 *     header — a spawn-authenticated caller must never be able to attach a
 *     second in-project session id via the header and redirect the probe to
 *     another session owner's HOME.
 *   - Even the resolved session is bound to the **requested project** (session →
 *     agent → project) and only an in-project session resolves to its owner. A
 *     spoofed id pointing at a session in another project (another user's AWS
 *     token) resolves to null and falls back to the host HOME. A legitimate
 *     agent only ever probes its own project's AWS status, so this never
 *     rejects the real flow.
 *
 * This is still not cross-user *scanning*: it resolves exactly one session's
 * owner, the same attribution kanban card linking and native PR authorship use.
 */
import type { Request } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { AGENT_HUB_SESSION_ID_HEADER } from './kanban-caller-session.js';
import type { AgentLookup, SessionRow, Stmts } from './types.js';

export interface AwsProbeContext {
  /** Prepared-statement access for the session row lookup. */
  stmts: Pick<Stmts, 'getSession'>;
  /** Resolves an agent id to its `{ project, agent }` — used for project binding. */
  findAgent: (agentId: string) => AgentLookup | null;
  /** Project id from the request path the probe is scoped to. */
  projectId: string;
}

export function resolveAwsProbeUserId(req: Request, ctx: AwsProbeContext): string | null {
  const authed = req as AuthenticatedRequest;

  const authUserId = authed.authUserId;
  if (typeof authUserId === 'string' && authUserId.trim()) {
    return authUserId.trim();
  }

  // Break-glass (no per-user identity): attribute to the originating session's
  // owner. Source precedence is security-critical (see file header) — the bound
  // spawn-session id wins over the attacker-controllable header.
  const sessionId = resolveProbeSessionId(authed);
  if (!sessionId) return null;

  const session = ctx.stmts.getSession.get(sessionId) as SessionRow | undefined;
  if (!session) return null;

  // Bind session → agent → project, and require it to match the request path so
  // a foreign-project session id cannot redirect the probe to an unrelated
  // user's AWS token.
  const agentId = session.agent_id;
  if (!agentId) return null;
  const lookup = ctx.findAgent(agentId);
  if (!lookup || lookup.project.id !== ctx.projectId) return null;

  const owner = session.owner_user_id;
  return typeof owner === 'string' && owner.trim() ? owner.trim() : null;
}

/**
 * Resolve the originating session id for a break-glass AWS probe, preferring
 * the cryptographically bound `authSpawnSessionId` over the attacker-
 * controllable `X-Agent-Hub-Session-Id` header. Deliberately does NOT reuse
 * `resolveCardSessionId` (which prefers the header).
 */
function resolveProbeSessionId(authed: AuthenticatedRequest): string | null {
  const bound = authed.authSpawnSessionId;
  if (typeof bound === 'string' && bound.trim()) return bound.trim();

  const header = authed.get(AGENT_HUB_SESSION_ID_HEADER);
  return typeof header === 'string' && header.trim() ? header.trim() : null;
}
