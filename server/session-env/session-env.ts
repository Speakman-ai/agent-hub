/**
 * SessionEnv — the swappable isolation boundary for per-session runtimes.
 *
 * The dev-server runtime, PTY host, and port allocator all program against
 * this interface instead of host `child_process`, so the run location is a
 * pluggable backend rather than a rewrite:
 *
 *   - `host`   — direct host processes + node-pty + loopback host ports.
 *                The local-dev/Mac path and the fast fallback everywhere.
 *   - `sysbox` — per-session rootless container via sysbox-runc. The
 *                default boundary on a self-hosted Linux server. (Separate
 *                adapter; registered when it ships.)
 *
 * Backend selection lives in `select-session-env.ts`; the host adapter in
 * `host-session-env.ts`.
 */

export type SessionEnvKind = 'host' | 'sysbox';

/** `sessionEnvAdapter` config values. `auto` = sysbox when available, else host. */
export type SessionEnvBackendChoice = 'auto' | SessionEnvKind;

export interface SessionEnvSpawnOpts {
  /**
   * Working directory **relative to the worktree root**. Absolute paths and
   * `..` escapes are rejected — the env's filesystem surface is the mounted
   * worktree, and the sysbox adapter cannot honor host-absolute paths.
   */
  cwd?: string;
  /** Extra env merged over the adapter's base env (base loses on conflict). */
  env?: Record<string, string>;
  /** Label used in logs and error messages. Defaults to the command text. */
  name?: string;
}

export interface SessionEnvExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process failed to spawn (e.g. ENOENT) rather than exiting. */
  error?: Error;
}

/**
 * Handle to a process running inside the env. All subscription methods
 * return an unsubscribe function; `onExit` fires immediately (sync) when
 * the process has already exited.
 */
export interface SessionEnvProcess {
  readonly pid: number | null;
  readonly name: string;
  readonly exited: boolean;
  readonly exitResult: SessionEnvExit | null;
  onStdout(cb: (chunk: string) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onExit(cb: (result: SessionEnvExit) => void): () => void;
  /**
   * Signal the process. Adapters target the whole process tree where the
   * platform allows (host: process-group kill), so dev servers that fork
   * children are reaped with their parent.
   */
  kill(signal?: NodeJS.Signals): void;
}

export interface SessionEnvPtyOpts {
  /** Program to run. Defaults to the env's login shell. */
  command?: string;
  args?: string[];
  /** Same relative-to-worktree contract as {@link SessionEnvSpawnOpts.cwd}. */
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  name?: string;
}

export interface SessionEnvPty {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): () => void;
  kill(signal?: string): void;
}

export interface SessionEnvPortMapping {
  /** Port the process listens on inside the env. */
  internalPort: number;
  /** Loopback host port the Hub (preview proxy) dials. */
  hostPort: number;
  /**
   * Port the process must actually bind inside the env — what the
   * dev-server runtime announces via `PORT`. The host adapter has no
   * port translation, so this equals `hostPort`; a containerized
   * adapter (sysbox) publishes `hostPort` → `internalPort` and sets
   * this to `internalPort`.
   */
  envPort: number;
  /** Always loopback — upstream ports are never exposed off-host. */
  hostUrl: string;
}

export interface SessionEnvWorktreeMount {
  /** Worktree path on the Hub host (what `worktree.ts` created). */
  hostPath: string;
  /** The same tree as seen from inside the env (== hostPath on `host`). */
  envPath: string;
}

/** Thrown by every op after {@link SessionEnv.dispose} settles the env. */
export class SessionEnvDisposedError extends Error {
  constructor(sessionId: string, op: string) {
    super(`SessionEnv for session ${sessionId} is disposed (rejected ${op})`);
    this.name = 'SessionEnvDisposedError';
  }
}

export interface SessionEnvDisposeOpts {
  /** ms between SIGTERM and SIGKILL for survivors. Default 5000. */
  graceMs?: number;
}

export interface SessionEnv {
  readonly kind: SessionEnvKind;
  readonly sessionId: string;
  readonly disposed: boolean;
  readonly createdAtMs: number;
  /**
   * Last observed activity (spawn, pty open, pty I/O, process output, or an
   * explicit {@link touch}). The reaper uses this for idle teardown.
   */
  readonly lastActivityAtMs: number;

  /** Run `command` via `sh -c` inside the env. */
  spawn(command: string, opts?: SessionEnvSpawnOpts): SessionEnvProcess;
  /** Open an interactive PTY inside the env. */
  openPty(opts?: SessionEnvPtyOpts): Promise<SessionEnvPty>;
  /**
   * Resolve (allocating on first call, cached after) the loopback host port
   * for an internal port. Idempotent per internal port for the env's life.
   */
  mapPort(internalPort: number): Promise<SessionEnvPortMapping>;
  /** All mappings established so far. */
  listPortMappings(): SessionEnvPortMapping[];
  /** Ensure the session worktree is visible inside the env. Idempotent. */
  mountWorktree(): Promise<SessionEnvWorktreeMount>;

  // ── Lifecycle / reap hooks ─────────────────────────────────────
  /** Processes + PTYs currently alive inside the env. */
  liveProcessCount(): number;
  /** Bump {@link lastActivityAtMs} (e.g. on proxy traffic). */
  touch(): void;
  /** Register a hook fired exactly once when disposal completes. */
  onDispose(cb: () => void): () => void;
  /**
   * Tear the env down: SIGTERM everything live, SIGKILL survivors after the
   * grace window, release port mappings, fire dispose hooks. Idempotent —
   * concurrent/repeat calls await the same teardown. After this resolves,
   * every other op throws {@link SessionEnvDisposedError}.
   */
  dispose(opts?: SessionEnvDisposeOpts): Promise<void>;
}

/** Tiny injectable clock so tests can step the dispose grace window. */
export interface SessionEnvClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export const systemSessionEnvClock: SessionEnvClock = {
  nowMs: () => Date.now(),
  sleep: (ms) =>
    new Promise((r) => {
      // unref: the dispose grace timer must not hold the event loop open
      // (Promise.race abandons it when everything exits before the window).
      const t = setTimeout(r, ms);
      t.unref?.();
    }),
};

/**
 * Validate + resolve a `cwd` option against the worktree root. Returns the
 * joined path; throws on absolute paths or `..` escapes (same contract as
 * `dev-server-config.ts`'s cwd validator).
 */
export function resolveEnvRelativeCwd(worktreeRoot: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '' || cwd === '.') return worktreeRoot;
  if (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)) {
    throw new Error(`cwd must be relative to the worktree root (got ${JSON.stringify(cwd)})`);
  }
  const segments = cwd.replace(/\\/g, '/').split('/');
  if (segments.some((seg) => seg === '..')) {
    throw new Error(`cwd must not escape the worktree root (no \`..\` segments): ${cwd}`);
  }
  const joined = segments.filter((seg) => seg !== '' && seg !== '.').join('/');
  return joined.length > 0 ? `${worktreeRoot}/${joined}` : worktreeRoot;
}
