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
const TOKEN_SECRET_ENV = 'FINALIZE_RUNNER_TOKEN_SECRET';
const DEFAULT_AGENT_TOKEN_TTL_MS = 24 * 60 * 60_000;

export interface AgentTokenPayload {
  agentId: string;
  /** 'shared' (multi-tenant pool) or a specific org id (dedicated). */
  orgScope: string;
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

/** True when runner registration is enabled (a fleet token is configured). */
export function isRunnerFleetEnabled(): boolean {
  return !!process.env[FLEET_TOKEN_ENV];
}

/** Verify the shared fleet token presented at /register. */
export function verifyFleetToken(provided: string | undefined): boolean {
  const expected = process.env[FLEET_TOKEN_ENV];
  if (!expected || !provided) return false;
  return safeEqual(provided, expected);
}

export function signAgentToken(
  args: { agentId: string; orgScope: string },
  opts?: { now?: number; ttlMs?: number },
): string {
  const now = opts?.now ?? Date.now();
  const payload: AgentTokenPayload = {
    agentId: args.agentId,
    orgScope: args.orgScope,
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
