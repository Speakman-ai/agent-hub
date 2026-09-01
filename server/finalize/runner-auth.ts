/**
 * runner-auth.ts — authentication for the runner fleet control plane.
 *
 * Two credentials:
 *  - Fleet token: a shared secret the agent presents at /register (from the ECS
 *    task env, sourced from Secrets Manager). Proves "I'm one of our runners."
 *  - Agent token: a short-lived HMAC-signed token the Hub mints at /register and
 *    the agent presents on every subsequent call. Carries the agent id + org
 *    scope so the Hub can authorize per-job access.
 *
 * Self-contained HMAC (no external jwt dep / Hub auth coupling) keeps the agent
 * binary tiny and the boundary auditable. Per-tenant, per-job STS credential
 * minting (the plan's stronger isolation) layers on top of this later.
 */
import { createHmac, timingSafeEqual } from 'crypto';

const FLEET_TOKEN_ENV = 'FINALIZE_RUNNER_FLEET_TOKEN';
const ORG_FLEET_TOKENS_ENV = 'FINALIZE_RUNNER_ORG_FLEET_TOKENS';
const TOKEN_SECRET_ENV = 'FINALIZE_RUNNER_TOKEN_SECRET';
const DEFAULT_AGENT_TOKEN_TTL_MS = 24 * 60 * 60_000;

export interface AgentTokenPayload {
  agentId: string;
  /** 'shared' (multi-tenant pool) or a specific org id (dedicated). */
  orgScope: string;
  /**
   * Runner queue class this agent claims (baked in at register so it can't be
   * spoofed per-claim). `default` = Linux DinD agents; `macos` = native macOS
   * runners. The claim route passes this to `claimRunnerJob` so an agent only
   * ever picks up jobs of its own class. Absent on legacy tokens → `default`.
   */
  runnerClass?: string;
  iat: number;
  exp: number;
}

function tokenSecret(): string {
  // Fall back to the fleet token so a single configured secret works in dev.
  return process.env[TOKEN_SECRET_ENV] || process.env[FLEET_TOKEN_ENV] || '';
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function hmac(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Org-scoped fleet tokens: `FINALIZE_RUNNER_ORG_FLEET_TOKENS` is a JSON map of
 * `{ "<orgId>": "<secret>" }`. A token here proves "may register an agent for
 * THIS org only" — it can never register a `shared` (multi-tenant) agent or one
 * for a different org. This is the narrowly-scoped registration mechanism native
 * (same-UID) runners must use: even if job code on the Mac reads the token, its
 * blast radius is the single org the runner already serves, so it cannot claim
 * other tenants' jobs (see the register route + macos-runner.md).
 */
function parseOrgFleetTokens(env: NodeJS.ProcessEnv): Array<{ org: string; token: string }> {
  const raw = env[ORG_FLEET_TOKENS_ENV];
  if (!raw) return [];
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj as Record<string, unknown>)
    .filter(
      ([org, tok]) => typeof tok === 'string' && tok.length > 0 && /^[A-Za-z0-9_-]+$/.test(org),
    )
    .map(([org, tok]) => ({ org, token: tok as string }));
}

/** True when runner registration is enabled (a global or org-scoped token is configured). */
export function isRunnerFleetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env[FLEET_TOKEN_ENV] || parseOrgFleetTokens(env).length > 0;
}

export interface FleetTokenAuth {
  ok: boolean;
  /**
   * When set, the presented token is an ORG-SCOPED token and may register an
   * agent ONLY for this org scope — the register route pins the agent to it and
   * rejects any other requested scope. Absent for the global fleet token, which
   * (as the trusted, container-isolated Linux DinD fleet credential) may register
   * the requested scope including `shared`.
   */
  forcedOrgScope?: string;
}

/**
 * Authenticate a fleet token presented at /register. Matches the global fleet
 * token first (unrestricted scope), then any org-scoped token (pinned to its
 * org). Constant-time comparison; returns `{ ok: false }` on no match.
 */
export function authenticateFleetToken(
  provided: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FleetTokenAuth {
  if (!provided) return { ok: false };
  const global = env[FLEET_TOKEN_ENV];
  if (global && safeEqual(provided, global)) return { ok: true };
  for (const { org, token } of parseOrgFleetTokens(env)) {
    if (safeEqual(provided, token)) return { ok: true, forcedOrgScope: org };
  }
  return { ok: false };
}

/** Verify the shared fleet token presented at /register (back-compat boolean). */
export function verifyFleetToken(provided: string | undefined): boolean {
  return authenticateFleetToken(provided).ok;
}

export function signAgentToken(
  args: { agentId: string; orgScope: string; runnerClass?: string },
  opts?: { now?: number; ttlMs?: number },
): string {
  const now = opts?.now ?? Date.now();
  const payload: AgentTokenPayload = {
    agentId: args.agentId,
    orgScope: args.orgScope,
    ...(args.runnerClass ? { runnerClass: args.runnerClass } : {}),
    iat: now,
    exp: now + (opts?.ttlMs ?? DEFAULT_AGENT_TOKEN_TTL_MS),
  };
  const body = b64url(JSON.stringify(payload));
  const sig = hmac(body, tokenSecret());
  return `${body}.${sig}`;
}

export function verifyAgentToken(
  token: string | undefined,
  opts?: { now?: number },
): AgentTokenPayload | null {
  if (!token) return null;
  const secret = tokenSecret();
  if (!secret) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!safeEqual(sig, hmac(body, secret))) return null;
  let payload: AgentTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AgentTokenPayload;
  } catch {
    return null;
  }
  const now = opts?.now ?? Date.now();
  if (typeof payload.exp !== 'number' || payload.exp < now) return null;
  return payload;
}

/** Extract a Bearer token from an Authorization header. */
export function bearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return m ? m[1] : undefined;
}
