/**
 * Runner protocol — wire format between the Agent Hub control plane and
 * a runner process living on a user's machine.
 *
 * Phase 1 scope: registration, auth handshake, and ping/pong.
 * Phase 2 scope: process lifecycle (spawn / cancel / stdin / stream /
 * exit / result). Filesystem and git ops still land in later phases —
 * Phase 2 bundles a single optional `workspace` block into the spawn
 * message so the runner can prepare a worktree before exec without
 * needing a separate `fs` / `git` command surface yet.
 *
 * Design notes:
 *   - Single outbound WebSocket per runner. Runner connects, sends `auth`,
 *     server responds `registered` (success) or `auth_error` (close).
 *   - Bi-directional messages after auth. Control-plane → runner messages
 *     carry an `id` for request/response correlation. Runner → control
 *     plane events use the same `id` to reply (`result`) or stream
 *     (`stream`, `exit`).
 *   - Versioned via `RUNNER_PROTOCOL_VERSION`. Bumps follow semver:
 *       * patch — additive, runners on older versions still work
 *       * minor — additive but server may require new optional fields
 *       * major — breaking; older runners are rejected at handshake
 *   - Phase 2 is a minor bump: 1.0.x runners continue to work for
 *     ping/pong-only deployments; the server only routes spawn traffic
 *     to runners that advertised `engines` capabilities at handshake.
 */

export const RUNNER_PROTOCOL_VERSION = '1.1.0';

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

// ─── Phase 2: process lifecycle (server → runner) ──────────────────────

/** Engines a runner may be asked to spawn. Kept as a string so adding a new
 * engine on the control plane does not require a runner version bump. */
export type RunnerEngine = string;

/** Optional worktree preparation bundled into a spawn request.
 * The runner is expected to:
 *   1. Clone or fetch `repoUrl` into a runner-managed scratch directory.
 *   2. Check out `baseRef` (commit/branch) and create branch `branch`.
 *   3. Use the resulting path as the spawned process `cwd`.
 * Failure at any step is reported back as a `result { ok:false, errorCode:'workspace_failed' }`
 * — the runner MUST NOT fall through to a half-prepared workspace. */
export interface RunnerWorkspaceSpec {
  /** Git remote URL the runner can clone (https or ssh). */
  repoUrl: string;
  /** Branch name the runner should create / check out for this run. */
  branch: string;
  /** Optional base ref (branch or commit SHA) to branch from. Defaults to
   * the remote's default branch when omitted. */
  baseRef?: string;
}

export interface RunnerSpawnMessage {
  type: 'spawn';
  /** Correlation id reused on cancel/stdin/stream/exit/result. */
  id: string;
  /** Engine identifier (e.g. `claude-code`, `cursor-agent`). The runner
   * resolves the actual binary path locally — control plane never sends
   * filesystem paths. */
  engine: RunnerEngine;
  /** CLI args to pass after the binary, in order. */
  args: string[];
  /** Extra env vars merged on top of the runner's own env. Reserved keys
   * (`PATH`, `HOME`) MAY be overridden but the runner is allowed to refuse. */
  env?: Record<string, string>;
  /** Agent Hub session id this spawn belongs to. The runner does not
   * interpret this value — it round-trips on every stream/exit/result so
   * the control plane can route output back to the right session. */
  sessionId: string;
  /** Optional worktree to prepare before exec. When omitted the runner
   * uses its own configured working directory. */
  workspace?: RunnerWorkspaceSpec;
  /** Optional initial stdin payload. Written immediately after spawn,
   * before any subsequent `stdin` frames. */
  stdin?: string;
}

export interface RunnerCancelMessage {
  type: 'cancel';
  /** The spawn id to terminate. Unknown ids are silently ignored. */
  id: string;
  /** POSIX signal name. Defaults to `SIGTERM` on the runner. */
  signal?: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | 'SIGHUP';
}

export interface RunnerStdinMessage {
  type: 'stdin';
  /** The spawn id to write to. */
  id: string;
  /** UTF-8 chunk to write to the process stdin. */
  data: string;
  /** When true, close stdin after this write (EOF). */
  end?: boolean;
}

// ─── Runner → server ───────────────────────────────────────────────────

export interface RunnerPongMessage {
  type: 'pong';
  /** Echo of the ping id. */
  id: string;
  /** Runner timestamp (ISO). */
  ts: string;
}

/** Ack to a `spawn` request. `ok:true` means the process started (pid
 * available); `ok:false` means the runner failed to start it and the
 * server can release the dispatch slot. */
export interface RunnerResultMessage {
  type: 'result';
  /** Echo of the spawn id. */
  id: string;
  ok: boolean;
  /** Set when `ok:true`. Informational — the control plane keys on `id`. */
  pid?: number;
  /** Set when `ok:false`. Stable code for programmatic handling. */
  errorCode?:
    | 'spawn_failed'
    | 'unknown_engine'
    | 'workspace_failed'
    | 'binary_not_found'
    | 'unknown';
  /** Human-readable explanation paired with `errorCode`. */
  error?: string;
}

/** Coalesced stdout/stderr chunk. Frames carry a monotonically increasing
 * `seq` per (id, channel) pair so the server can detect drops if the
 * runner's send buffer overflows. */
export interface RunnerStreamMessage {
  type: 'stream';
  /** The spawn id this chunk belongs to. */
  id: string;
  /** Which fd produced the bytes. */
  channel: 'stdout' | 'stderr';
  /** UTF-8 chunk. The runner SHOULD coalesce up to ~50ms of output into
   * a single frame to limit per-frame overhead. */
  data: string;
  /** Per-(id,channel) frame counter, starts at 0 and increments by 1. */
  seq: number;
}

/** Process finished. Either `code` (clean exit) or `signal` (killed) is
 * set; both null when the runner detached without observing the exit. */
export interface RunnerExitMessage {
  type: 'exit';
  /** Echo of the spawn id. */
  id: string;
  /** Exit code, or null when terminated by signal / lost. */
  code: number | null;
  /** POSIX signal name when terminated by signal, otherwise null. */
  signal: string | null;
}

// ─── Unions ────────────────────────────────────────────────────────────

/** Server-side parser input — messages we receive from a runner. */
export type RunnerInbound =
  | RunnerAuthMessage
  | RunnerPongMessage
  | RunnerResultMessage
  | RunnerStreamMessage
  | RunnerExitMessage;

/** Runner-side parser input — messages the server sends to the runner. */
export type RunnerOutbound =
  | RunnerRegisteredMessage
  | RunnerAuthErrorMessage
  | RunnerPingMessage
  | RunnerSpawnMessage
  | RunnerCancelMessage
  | RunnerStdinMessage;

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
    case 'result':
      return parseResult(obj);
    case 'stream':
      return parseStream(obj);
    case 'exit':
      return parseExit(obj);
    default:
      return null;
  }
}

/**
 * Parse a JSON frame received by the runner from the control plane.
 * Mirrors `parseRunnerInbound` for the opposite direction. Returns `null`
 * for malformed input — the runner client should disconnect on null.
 */
export function parseRunnerOutbound(raw: string | Buffer): RunnerOutbound | null {
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
    case 'registered':
      if (
        typeof obj.runnerId !== 'string' ||
        typeof obj.serverVersion !== 'string' ||
        typeof obj.connectedAt !== 'string'
      ) {
        return null;
      }
      return {
        type: 'registered',
        runnerId: obj.runnerId,
        serverVersion: obj.serverVersion,
        connectedAt: obj.connectedAt,
      };
    case 'auth_error': {
      if (typeof obj.code !== 'string' || typeof obj.message !== 'string') return null;
      const codes = [
        'unknown_runner',
        'bad_token',
        'incompatible_version',
        'malformed',
        'already_authed',
      ];
      if (!codes.includes(obj.code)) return null;
      return {
        type: 'auth_error',
        code: obj.code as RunnerAuthErrorMessage['code'],
        message: obj.message,
      };
    }
    case 'ping':
      if (typeof obj.id !== 'string' || typeof obj.ts !== 'string') return null;
      return { type: 'ping', id: obj.id, ts: obj.ts };
    case 'spawn':
      return parseSpawn(obj);
    case 'cancel':
      return parseCancel(obj);
    case 'stdin':
      return parseStdin(obj);
    default:
      return null;
  }
}

// ─── Per-message parsers (Phase 2) ─────────────────────────────────────

function parseResult(obj: Record<string, unknown>): RunnerResultMessage | null {
  if (typeof obj.id !== 'string' || typeof obj.ok !== 'boolean') return null;
  const out: RunnerResultMessage = { type: 'result', id: obj.id, ok: obj.ok };
  if (obj.pid !== undefined) {
    if (typeof obj.pid !== 'number' || !Number.isFinite(obj.pid)) return null;
    out.pid = obj.pid;
  }
  if (obj.errorCode !== undefined) {
    if (typeof obj.errorCode !== 'string') return null;
    const codes = [
      'spawn_failed',
      'unknown_engine',
      'workspace_failed',
      'binary_not_found',
      'unknown',
    ];
    if (!codes.includes(obj.errorCode)) return null;
    out.errorCode = obj.errorCode as RunnerResultMessage['errorCode'];
  }
  if (obj.error !== undefined) {
    if (typeof obj.error !== 'string') return null;
    out.error = obj.error;
  }
  return out;
}

function parseStream(obj: Record<string, unknown>): RunnerStreamMessage | null {
  if (
    typeof obj.id !== 'string' ||
    typeof obj.data !== 'string' ||
    typeof obj.seq !== 'number' ||
    !Number.isInteger(obj.seq) ||
    obj.seq < 0
  ) {
    return null;
  }
  if (obj.channel !== 'stdout' && obj.channel !== 'stderr') return null;
  return {
    type: 'stream',
    id: obj.id,
    channel: obj.channel,
    data: obj.data,
    seq: obj.seq,
  };
}

function parseExit(obj: Record<string, unknown>): RunnerExitMessage | null {
  if (typeof obj.id !== 'string') return null;
  let code: number | null;
  if (obj.code === null) {
    code = null;
  } else if (typeof obj.code === 'number' && Number.isInteger(obj.code)) {
    code = obj.code;
  } else {
    return null;
  }
  let signal: string | null;
  if (obj.signal === null || obj.signal === undefined) {
    signal = null;
  } else if (typeof obj.signal === 'string') {
    signal = obj.signal;
  } else {
    return null;
  }
  return { type: 'exit', id: obj.id, code, signal };
}

function parseSpawn(obj: Record<string, unknown>): RunnerSpawnMessage | null {
  if (
    typeof obj.id !== 'string' ||
    typeof obj.engine !== 'string' ||
    typeof obj.sessionId !== 'string' ||
    !Array.isArray(obj.args) ||
    !obj.args.every((a) => typeof a === 'string')
  ) {
    return null;
  }
  const out: RunnerSpawnMessage = {
    type: 'spawn',
    id: obj.id,
    engine: obj.engine,
    args: obj.args as string[],
    sessionId: obj.sessionId,
  };
  if (obj.env !== undefined) {
    if (!isStringRecord(obj.env)) return null;
    out.env = obj.env;
  }
  if (obj.workspace !== undefined) {
    const ws = parseWorkspace(obj.workspace);
    if (!ws) return null;
    out.workspace = ws;
  }
  if (obj.stdin !== undefined) {
    if (typeof obj.stdin !== 'string') return null;
    out.stdin = obj.stdin;
  }
  return out;
}

function parseCancel(obj: Record<string, unknown>): RunnerCancelMessage | null {
  if (typeof obj.id !== 'string') return null;
  const out: RunnerCancelMessage = { type: 'cancel', id: obj.id };
  if (obj.signal !== undefined) {
    if (
      obj.signal !== 'SIGTERM' &&
      obj.signal !== 'SIGKILL' &&
      obj.signal !== 'SIGINT' &&
      obj.signal !== 'SIGHUP'
    ) {
      return null;
    }
    out.signal = obj.signal;
  }
  return out;
}

function parseStdin(obj: Record<string, unknown>): RunnerStdinMessage | null {
  if (typeof obj.id !== 'string' || typeof obj.data !== 'string') return null;
  const out: RunnerStdinMessage = { type: 'stdin', id: obj.id, data: obj.data };
  if (obj.end !== undefined) {
    if (typeof obj.end !== 'boolean') return null;
    out.end = obj.end;
  }
  return out;
}

function parseWorkspace(v: unknown): RunnerWorkspaceSpec | null {
  if (!v || typeof v !== 'object') return null;
  const w = v as Record<string, unknown>;
  if (typeof w.repoUrl !== 'string' || typeof w.branch !== 'string') return null;
  const out: RunnerWorkspaceSpec = { repoUrl: w.repoUrl, branch: w.branch };
  if (w.baseRef !== undefined) {
    if (typeof w.baseRef !== 'string') return null;
    out.baseRef = w.baseRef;
  }
  return out;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const val of Object.values(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return false;
  }
  return true;
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
