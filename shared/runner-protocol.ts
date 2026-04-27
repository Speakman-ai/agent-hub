/**
 * Runner protocol — wire format between the Agent Hub control plane and
 * a runner process living on a user's machine.
 *
 * Phase 1 scope: registration, auth handshake, and ping/pong. No spawn,
 * fs, or git commands yet — those land in later phases as new message
 * types are added to the unions below.
 *
 * Design notes:
 *   - Single outbound WebSocket per runner. Runner connects, sends `auth`,
 *     server responds `registered` (success) or `auth_error` (close).
 *   - Bi-directional messages after auth. Control-plane → runner messages
 *     carry an `id` for request/response correlation. Runner → control
 *     plane events do not require an `id` unless they are replying to a
 *     request (`type: "result"`, see future phases).
 *   - Versioned via `RUNNER_PROTOCOL_VERSION`. Bumps follow semver:
 *       * patch — additive, runners on older versions still work
 *       * minor — additive but server may require new optional fields
 *       * major — breaking; older runners are rejected at handshake
 */

export const RUNNER_PROTOCOL_VERSION = '1.0.0';

// ─── Auth handshake (runner → server, first message) ───────────────────

export interface RunnerAuthMessage {
  type: 'auth';
  /** UUID assigned at registration time. */
  runnerId: string;
  /** Plaintext token issued at registration. Server compares against hash. */
  token: string;
  /** Protocol version the runner speaks. */
  version: string;
  /** Capabilities the runner advertises (engines, OS, runner build, etc.). */
  capabilities?: RunnerCapabilities;
}

export interface RunnerCapabilities {
  /** OS / arch — informational, not used for routing in phase 1. */
  os?: string;
  arch?: string;
  /** Runner build identifier (git sha or version string). */
  runnerVersion?: string;
  /** CLI engines this runner can spawn (claude, cursor-agent, codex, gemini). */
  engines?: string[];
  /** Machine hostname — informational, helps operators identify runners. */
  hostname?: string;
}

// ─── Server → runner ───────────────────────────────────────────────────

export interface RunnerRegisteredMessage {
  type: 'registered';
  runnerId: string;
  /** Server's protocol version — runner can warn on mismatch. */
  serverVersion: string;
  /** ISO timestamp the server records as the connection time. */
  connectedAt: string;
}

export interface RunnerAuthErrorMessage {
  type: 'auth_error';
  /** Stable error code for programmatic handling. */
  code: 'unknown_runner' | 'bad_token' | 'incompatible_version' | 'malformed' | 'already_authed';
  /** Human-readable explanation for logs. */
  message: string;
}

export interface RunnerPingMessage {
  type: 'ping';
  /** Server-assigned id; runner echoes in pong. */
  id: string;
  /** Server timestamp (ISO). */
  ts: string;
}

// ─── Runner → server ───────────────────────────────────────────────────

export interface RunnerPongMessage {
  type: 'pong';
  /** Echo of the ping id. */
  id: string;
  /** Runner timestamp (ISO). */
  ts: string;
}

// ─── Unions ────────────────────────────────────────────────────────────

export type RunnerInbound = RunnerAuthMessage | RunnerPongMessage;

export type RunnerOutbound = RunnerRegisteredMessage | RunnerAuthErrorMessage | RunnerPingMessage;

// ─── Parse + validate ──────────────────────────────────────────────────

/**
 * Parse a JSON frame into a runner-inbound message. Returns `null` for
 * any malformed input — the WS handler should treat null as a protocol
 * violation and disconnect.
 */
export function parseRunnerInbound(raw: string | Buffer): RunnerInbound | null {
  let text: string;
  try {
    text = typeof raw === 'string' ? raw : raw.toString('utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case 'auth':
      if (
        typeof obj.runnerId !== 'string' ||
        typeof obj.token !== 'string' ||
        typeof obj.version !== 'string'
      ) {
        return null;
      }
      return {
        type: 'auth',
        runnerId: obj.runnerId,
        token: obj.token,
        version: obj.version,
        capabilities: isCapabilities(obj.capabilities) ? obj.capabilities : undefined,
      };
    case 'pong':
      if (typeof obj.id !== 'string' || typeof obj.ts !== 'string') return null;
      return { type: 'pong', id: obj.id, ts: obj.ts };
    default:
      return null;
  }
}

function isCapabilities(v: unknown): v is RunnerCapabilities {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (c.os !== undefined && typeof c.os !== 'string') return false;
  if (c.arch !== undefined && typeof c.arch !== 'string') return false;
  if (c.runnerVersion !== undefined && typeof c.runnerVersion !== 'string') return false;
  if (c.engines !== undefined) {
    if (!Array.isArray(c.engines)) return false;
    if (!c.engines.every((e) => typeof e === 'string')) return false;
  }
  if (c.hostname !== undefined && typeof c.hostname !== 'string') return false;
  return true;
}

/**
 * Major-version compatibility check. We accept any runner whose major
 * version equals the server's. Differing minor/patch is logged but does
 * not reject the connection.
 */
export function isCompatibleVersion(
  runnerVersion: string,
  serverVersion = RUNNER_PROTOCOL_VERSION,
): boolean {
  const r = runnerVersion.split('.')[0];
  const s = serverVersion.split('.')[0];
  return Boolean(r) && r === s;
}
