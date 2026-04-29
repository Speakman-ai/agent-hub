/**
 * Runner transport — abstracts CLI spawning so callers (chat.ts, delegation,
 * etc.) can stay agnostic about whether the process runs on this machine
 * (`LocalSpawnTransport`) or on a remote runner reachable over the
 * Phase 2 WebSocket protocol (`RemoteRunnerTransport`).
 *
 * The `ProcessHandle` returned by `spawn()` is intentionally duck-compatible
 * with Node's `ChildProcess`: `pid`, `stdout`, `stderr`, `stdin`,
 * `kill(signal)`, and the `'close'` / `'error'` events. That means existing
 * callsites can be flipped to a transport with minimal code churn.
 *
 * Selection rule (lives in chat.ts):
 *   - `project.runnerId` null/absent → `LocalSpawnTransport`
 *   - `project.runnerId` set + runner online → `RemoteRunnerTransport`
 *   - `project.runnerId` set + runner offline → reject with `code:'RUNNER_OFFLINE'`
 *     so the chat handler can surface the toast-then-block UX.
 */

import { spawn as nodeSpawn } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough, Writable, type Readable } from 'stream';
import { randomUUID } from 'crypto';

import type {
  RunnerCancelMessage,
  RunnerInbound,
  RunnerSpawnMessage,
  RunnerStdinMessage,
  RunnerWorkspaceSpec,
} from '../shared/runner-protocol.js';

// ─── Public types ─────────────────────────────────────────────────────

export interface SpawnRequest {
  /** Engine identifier (e.g. `claude-code`). Echoed verbatim into the
   * remote protocol; informational for the local transport. */
  engine: string;
  /** Resolved binary path. Required for `LocalSpawnTransport`; ignored
   * by `RemoteRunnerTransport` because the runner resolves its own
   * `claudeBin` / `cursorBin`. */
  bin?: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Optional worktree spec — only forwarded by the remote transport. */
  workspace?: RunnerWorkspaceSpec;
  /** Agent Hub session id. Round-trips on remote messages so the control
   * plane can route stream/exit frames back to the right session. */
  sessionId: string;
  /** Optional initial stdin payload. */
  stdin?: string;
}

export type ProcessHandle = ChildProcessLike & {
  /** Stable correlation id. Local: stringified pid (or empty pre-pid).
   * Remote: protocol id used to correlate cancel/stdin/stream/exit. */
  readonly id: string;
};

/**
 * Subset of `ChildProcess` we depend on. Keeps `RemoteProcessHandle`
 * honest about which surface it must implement without pulling in
 * Node-only signals like `disconnect`.
 */
export interface ChildProcessLike extends EventEmitter {
  readonly pid: number | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly stdin: Writable | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface RunnerTransport {
  /** Resolves once the process has started (or rejects with a typed
   * error on spawn failure). */
  spawn(req: SpawnRequest): Promise<ProcessHandle>;
}

/**
 * Failure thrown by `RemoteRunnerTransport.spawn` and surfaced to chat.ts.
 * `code` is stable across versions; messages are human-readable.
 */
export interface RunnerTransportError extends Error {
  code:
    | 'RUNNER_OFFLINE'
    | 'RUNNER_DISCONNECTED'
    | 'SPAWN_FAILED'
    | 'UNKNOWN_ENGINE'
    | 'WORKSPACE_FAILED'
    | 'BINARY_NOT_FOUND'
    | 'UNKNOWN';
}

export function isRunnerTransportError(err: unknown): err is RunnerTransportError {
  return (
    Boolean(err) && err instanceof Error && typeof (err as { code?: unknown }).code === 'string'
  );
}

// ─── Local transport ──────────────────────────────────────────────────

/**
 * Wraps Node's `child_process.spawn`. Behaviour is identical to the
 * inline spawn that lived in `chat.ts` before Phase 2 — only the surface
 * has changed.
 */
export class LocalSpawnTransport implements RunnerTransport {
  async spawn(req: SpawnRequest): Promise<ProcessHandle> {
    if (!req.bin) {
      throw makeError('BINARY_NOT_FOUND', 'LocalSpawnTransport requires SpawnRequest.bin');
    }
    const child = nodeSpawn(req.bin, req.args, {
      cwd: req.cwd,
      env: req.env,
      // Match the historical chat.ts shape: stdin ignored, stdout/stderr piped.
      // When the caller passes `stdin` we upgrade stdin to a pipe so we can
      // write the initial payload — matches `delegation.ts` behaviour.
      stdio: req.stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    if (req.stdin !== undefined && child.stdin) {
      child.stdin.write(req.stdin);
    }
    // Attach a stable `id` getter without mutating the ChildProcess prototype.
    Object.defineProperty(child, 'id', {
      configurable: true,
      enumerable: false,
      get(): string {
        return child.pid != null ? String(child.pid) : '';
      },
    });
    return child as unknown as ProcessHandle;
  }
}

// ─── Remote transport ─────────────────────────────────────────────────

export interface RemoteRunnerTransportDeps {
  /** Returns a function that sends a JSON frame to the runner WS, or
   * `null` when the runner is not connected. The transport invokes this
   * once per spawn — disconnects after spawn surface via
   * `subscribeDisconnect` below, NOT via this `null` result (which only
   * covers the "never connected" case at spawn time). */
  getSender: (runnerId: string) => ((frame: object) => void) | null;
  /**
   * Subscribe to runner→server frames. The dispatcher in
   * `runners-ws.ts` calls every listener for parsed inbound messages
   * originating from this runner. The returned function unsubscribes.
   */
  subscribe: (runnerId: string, listener: (msg: RunnerInbound) => void) => () => void;
  /**
   * Subscribe to the one-shot disconnect signal for a runner. Fires
   * exactly once when the runner WS closes. The transport uses this to
   * tear down every `RemoteProcessHandle` it owns for that runner —
   * pending spawns reject with `RUNNER_DISCONNECTED`, started spawns
   * emit `'close'` so chat.ts's existing post-close cleanup runs (this
   * is what replaces `child_process`'s implicit close-on-exit
   * guarantee for the remote case).
   */
  subscribeDisconnect: (runnerId: string, listener: () => void) => () => void;
  /** Override the protocol id generator (tests). */
  generateId?: () => string;
  /**
   * Per-spawn ack timeout. If the runner accepts the WS frame but never
   * answers with `result`, the spawn promise rejects after this many
   * ms with `SPAWN_FAILED`. Defaults to `DEFAULT_SPAWN_TIMEOUT_MS`.
   * Set to `0` (or any non-positive number) to disable.
   */
  spawnTimeoutMs?: number;
}

/**
 * Default ack window for `RemoteRunnerTransport.spawn`. Long enough to
 * cover a runner cold-start (clone + npm install on a slow disk can
 * easily push 20s) but short enough that a wedged exec — or a runner
 * that swallowed the spawn frame and went dark before sending `result`
 * — surfaces as a clear failure rather than a permanently-stuck "agent
 * thinking" UI. Operators with truly long-running setup steps can dial
 * this up via `spawnTimeoutMs` per-deployment.
 */
export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;

/**
 * Bridges the remote protocol to the same `ProcessHandle` surface
 * `LocalSpawnTransport` returns. Stream frames push into a `PassThrough`,
 * `exit` triggers `'close'`, `kill()` sends a `cancel` frame, writes to
 * `stdin` send `stdin` frames.
 */
export class RemoteRunnerTransport implements RunnerTransport {
  constructor(
    public readonly runnerId: string,
    private readonly deps: RemoteRunnerTransportDeps,
  ) {}

  async spawn(req: SpawnRequest): Promise<ProcessHandle> {
    const sender = this.deps.getSender(this.runnerId);
    if (!sender) {
      throw makeError('RUNNER_OFFLINE', `Runner ${this.runnerId} is offline`);
    }
    const generateId = this.deps.generateId ?? randomUUID;
    const id = generateId();
    const handle = new RemoteProcessHandle(id, sender);

    const unsubscribe = this.deps.subscribe(this.runnerId, (msg) => {
      // Drop frames that don't belong to this spawn — the runner can be
      // multiplexing many spawns over one WS.
      if ((msg as { id?: unknown }).id !== id) return;
      handle._dispatch(msg);
    });
    handle._onTeardown(unsubscribe);

    // Wire the runner-disconnect signal to a synthetic close on this
    // handle so chat.ts's `proc.on('close')` path runs even when the
    // runner WS dies mid-stream. Without this, the chat session is
    // permanently wedged in the "thinking" state until the user navigates
    // away. See the matching docstring on `RemoteRunnerTransportDeps`.
    const unsubscribeDisconnect = this.deps.subscribeDisconnect(this.runnerId, () => {
      handle._handleDisconnect();
    });
    handle._onTeardown(unsubscribeDisconnect);

    const frame: RunnerSpawnMessage = {
      type: 'spawn',
      id,
      engine: req.engine,
      args: req.args,
      sessionId: req.sessionId,
    };
    if (req.env !== undefined) frame.env = stringifyEnv(req.env);
    if (req.workspace !== undefined) frame.workspace = req.workspace;
    if (req.stdin !== undefined) frame.stdin = req.stdin;

    const timeoutMs = this.deps.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS;

    return new Promise<ProcessHandle>((resolve, reject) => {
      // Single-shot guards so the result/timeout/disconnect race never
      // resolves+rejects (or rejects twice).
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        action();
      };

      let timeoutHandle: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          settle(() => {
            handle._teardown();
            reject(
              makeError(
                'SPAWN_FAILED',
                `Runner ${this.runnerId} did not ack spawn within ${timeoutMs}ms`,
              ),
            );
          });
        }, timeoutMs);
        // Don't keep the event loop alive solely for this timer.
        timeoutHandle.unref?.();
      }

      handle._awaitResult((ok, errCode, errMsg, pid) => {
        settle(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (ok) {
            handle._setPid(pid ?? null);
            resolve(handle);
          } else {
            handle._teardown();
            reject(makeError(mapErrorCode(errCode), errMsg ?? 'spawn failed'));
          }
        });
      });

      // The handle exposes its own one-shot pre-spawn rejection hook so
      // the disconnect listener (registered above) can unwind a spawn
      // that never got a `result`. Disconnect after spawn-ack flips the
      // handle to `_handleDisconnect`'s post-spawn branch (synthetic
      // close), which is harmless because `settled` is already true.
      handle._onPreSpawnFailure((err) => {
        settle(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          handle._teardown();
          reject(err);
        });
      });

      try {
        sender(frame);
      } catch (err) {
        settle(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          handle._teardown();
          const msg = err instanceof Error ? err.message : String(err);
          reject(makeError('SPAWN_FAILED', `Failed to send spawn frame: ${msg}`));
        });
      }
    });
  }
}

// ─── Internals ────────────────────────────────────────────────────────

class RemoteProcessHandle extends EventEmitter implements ChildProcessLike {
  readonly id: string;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
  readonly stdin: Writable;

  private _pid: number | null = null;
  private _resultListener: ResultListener | null = null;
  /** One-shot rejection hook used by the spawn-promise machinery to
   * unwind when the runner disappears (or any other failure mode)
   * before `result` arrives. After spawn-ack this is cleared and the
   * post-spawn close path takes over. */
  private _preSpawnFailure: ((err: RunnerTransportError) => void) | null = null;
  private _teardownFns: Array<() => void> = [];
  private _killed = false;
  private _exited = false;
  private _spawned = false;
  /** Per-channel last-seen seq for drop detection. */
  private _lastSeq: { stdout: number; stderr: number } = { stdout: -1, stderr: -1 };

  constructor(
    id: string,
    private readonly sender: (frame: object) => void,
  ) {
    super();
    this.id = id;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.stdin = makeRemoteStdin(id, sender);
  }

  get pid(): number | null {
    return this._pid;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    if (this._killed || this._exited) return false;
    this._killed = true;
    // Only forward `signal` when the caller explicitly passed one. An
    // undefined argument means "use the runner's default" — typically
    // SIGTERM — so we keep the wire frame minimal.
    const sig = signal === undefined ? undefined : normalizeSignal(signal);
    const frame: RunnerCancelMessage = sig
      ? { type: 'cancel', id: this.id, signal: sig }
      : { type: 'cancel', id: this.id };
    try {
      this.sender(frame);
    } catch {
      /* socket may have closed */
    }
    return true;
  }

  // ─── package-private helpers used by RemoteRunnerTransport ──────────

  _setPid(pid: number | null): void {
    this._pid = pid;
  }

  _onTeardown(fn: () => void): void {
    this._teardownFns.push(fn);
  }

  _teardown(): void {
    while (this._teardownFns.length) {
      try {
        this._teardownFns.shift()!();
      } catch {
        /* never let teardown throw */
      }
    }
  }

  _awaitResult(listener: ResultListener): void {
    this._resultListener = listener;
  }

  _onPreSpawnFailure(fn: (err: RunnerTransportError) => void): void {
    this._preSpawnFailure = fn;
  }

  /**
   * Surface a runner disconnect to the spawn promise (if still pending)
   * or to the post-spawn close path (if already started). One-shot —
   * subsequent calls (e.g. a delayed teardown after the WS finally
   * fires its real close event) are no-ops because `_exited` is set.
   */
  _handleDisconnect(): void {
    if (this._exited) return;
    if (!this._spawned) {
      // Spawn promise still pending — reject it with a typed error so
      // the caller's `try/catch` in chat.ts surfaces "Runner X
      // disconnected" instead of hanging forever.
      const fail = this._preSpawnFailure;
      this._preSpawnFailure = null;
      this._resultListener = null;
      if (fail) {
        fail(makeError('RUNNER_DISCONNECTED', `Runner disconnected before spawn ack`));
      }
      return;
    }
    // Post-spawn: synthesize a close event with no exit code/signal so
    // chat.ts's `proc.on('close')` cleanup runs and the user is no
    // longer stuck in "thinking…". `(null, null)` matches Node's
    // ChildProcess shape for "exited via signal we couldn't observe".
    this._exited = true;
    this.stdout.end();
    this.stderr.end();
    this._teardown();
    setImmediate(() => {
      this.emit('error', makeError('RUNNER_DISCONNECTED', 'Runner disconnected mid-spawn'));
      this.emit('close', null, null);
    });
  }

  _dispatch(msg: RunnerInbound): void {
    switch (msg.type) {
      case 'result': {
        const fn = this._resultListener;
        this._resultListener = null;
        // Mark spawn-acked so the disconnect handler takes the
        // post-spawn synthetic-close branch from here on.
        if (msg.ok) {
          this._spawned = true;
          this._preSpawnFailure = null;
        }
        if (fn) fn(msg.ok, msg.errorCode, msg.error, msg.pid);
        return;
      }
      case 'stream': {
        const last = this._lastSeq[msg.channel];
        if (msg.seq <= last) {
          // Out-of-order or duplicate frame — drop. The runner is supposed
          // to monotonically increase seq per (id, channel).
          return;
        }
        this._lastSeq[msg.channel] = msg.seq;
        const sink = msg.channel === 'stdout' ? this.stdout : this.stderr;
        sink.write(msg.data);
        return;
      }
      case 'exit': {
        if (this._exited) return;
        this._exited = true;
        // Defensive: if the runner sent `exit` without a preceding
        // `result` (protocol violation), the spawn promise is still
        // waiting. Reject it with a synthetic SPAWN_FAILED so callers
        // don't hang on a malformed frame sequence.
        if (this._resultListener || this._preSpawnFailure) {
          const fn = this._resultListener;
          this._resultListener = null;
          const fail = this._preSpawnFailure;
          this._preSpawnFailure = null;
          if (fn) {
            fn(false, 'spawn_failed', 'Runner emitted exit before result', undefined);
          } else if (fail) {
            fail(makeError('SPAWN_FAILED', 'Runner emitted exit before result'));
          }
        }
        this.stdout.end();
        this.stderr.end();
        this._teardown();
        // Fire `close` on the next tick so listeners attached after spawn
        // resolve still see the event (matches Node's ChildProcess timing).
        setImmediate(() => {
          this.emit('close', msg.code, msg.signal);
        });
        return;
      }
      default:
        // pong / auth / etc. — not addressed to us.
        return;
    }
  }
}

type ResultListener = (
  ok: boolean,
  errorCode: string | undefined,
  error: string | undefined,
  pid: number | undefined,
) => void;

/**
 * Build a `Writable` that forwards every write as a `stdin` protocol
 * frame. Uses a real `Writable` subclass (via `PassThrough`-like
 * `_write`) so it satisfies the full Node stream contract that
 * downstream code may exercise (`.pipe(...)`, `.cork()`, etc.).
 */
function makeRemoteStdin(id: string, sender: (frame: object) => void): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, cb: (err?: Error | null) => void) {
      const data = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      const frame: RunnerStdinMessage = { type: 'stdin', id, data };
      try {
        sender(frame);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
    final(cb: (err?: Error | null) => void) {
      const frame: RunnerStdinMessage = { type: 'stdin', id, data: '', end: true };
      try {
        sender(frame);
        cb();
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}

function stringifyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function normalizeSignal(signal: NodeJS.Signals | number): RunnerCancelMessage['signal'] {
  if (typeof signal === 'number') return undefined;
  if (signal === 'SIGTERM' || signal === 'SIGKILL' || signal === 'SIGINT' || signal === 'SIGHUP') {
    return signal;
  }
  return undefined;
}

function mapErrorCode(code: string | undefined): RunnerTransportError['code'] {
  switch (code) {
    case 'spawn_failed':
      return 'SPAWN_FAILED';
    case 'unknown_engine':
      return 'UNKNOWN_ENGINE';
    case 'workspace_failed':
      return 'WORKSPACE_FAILED';
    case 'binary_not_found':
      return 'BINARY_NOT_FOUND';
    default:
      return 'UNKNOWN';
  }
}

function makeError(code: RunnerTransportError['code'], message: string): RunnerTransportError {
  const err = new Error(message) as RunnerTransportError;
  err.code = code;
  return err;
}
