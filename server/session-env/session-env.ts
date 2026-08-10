/**
 * SessionEnv — the swappable isolation boundary for per-session runtimes.
 *
 * The dev-server runtime, PTY host, and port allocator all program against
 * this interface instead of host `child_process`, so the run location is a
 * pluggable backend rather than a rewrite:
 *
 *   - `host`      — direct host processes + node-pty + loopback host ports.
 *                   The local-dev/Mac path and the fast fallback everywhere.
 *   - `sysbox`    — per-session container via the sysbox-runc runtime. A real
 *                   user-namespace boundary, but needs sysbox installed on
 *                   the host.
 *   - `container` — per-session container via privileged DinD. Same shape as
 *                   `sysbox` with a weaker boundary, and it runs anywhere
 *                   Docker does — which is what makes per-session isolation
 *                   the default rather than an opt-in for specially prepared
 *                   hosts. Finalize CI already runs privileged DinD on these
 *                   same machines.
 *   - `firecracker` — per-session microVM. The session gets its own kernel
 *                   behind a hardware virtualization boundary rather than a
 *                   namespaced view of the host's. Needs KVM (`/dev/kvm`),
 *                   which on EC2 means a bare-metal or nested-virtualization
 *                   instance type.
 *
 * Backend selection lives in `select-session-env.ts`; adapters live in
 * `host-session-env.ts`, `sysbox-session-env.ts` (which serves both container
 * kinds — they differ only in the isolation runtime), and
 * `firecracker/firecracker-session-env.ts`.
 */

import type { SessionEnvPortRouting } from './container-routing.js';
import type { SessionWorktreeIo } from './worktree-io.js';

export type SessionEnvKind = 'host' | 'sysbox' | 'container' | 'firecracker';

/**
 * `sessionEnvAdapter` config values. `auto` picks the strongest boundary the
 * host can actually provide, in descending order of isolation.
 */
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
  /**
   * Write to the child's stdin. Optional — adapters that open stdin as
   * `ignore` (host preview spawns) omit these. Guest exec and any spawn that
   * needs a stdin prompt (Codex `-`) implement them.
   */
  writeStdin?(data: string | Buffer): void;
  /** Close stdin (EOF). */
  endStdin?(): void;
}

export interface SessionEnvPtyOpts {
  /** Program to run. Defaults to the env's login shell. */
  command?: string;
  args?: string[];
  /** Same relative-to-worktree contract as {@link SessionEnvSpawnOpts.cwd}. */
  cwd?: string;
  /**
   * Extra env merged over the adapter's base env. An `undefined` value unsets
   * the inherited variable rather than passing the string "undefined" through
   * (how the terminal drops ambient AWS credentials, see
   * `terminal/terminal-shell-env.ts`).
   */
  env?: Record<string, string | undefined>;
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
  /**
   * Host the Hub dials to reach this port: loopback when the env publishes
   * ports, the container's own address under container-IP routing. Carried
   * on the mapping so a synchronous caller (the preview proxy) can resolve a
   * full upstream without awaiting {@link SessionEnv.resolveDialTarget}.
   */
  host: string;
  /** Port the Hub (preview proxy) dials on {@link host}. */
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

/**
 * Where the Hub connects to reach a port inside the env.
 *
 * This is the seam that decouples "the app listens on port N" from "the Hub
 * publishes port N somewhere on the host." The two containerized routings
 * differ sharply:
 *
 *   - **Published ports** — the container maps `hostPort → internalPort` at
 *     `docker run` time, so every port must be known *before* the container
 *     starts and each one consumes a slot in a shared host-wide pool.
 *   - **Container IP** — the Hub dials the container's own address directly.
 *     Nothing is published, no pool exists to exhaust or collide on, and a
 *     port that appears minutes after boot is reachable immediately. This is
 *     what lets a session add a service without restarting its environment.
 *
 * The host adapter always reports loopback, since there is no boundary to
 * cross.
 */
export interface SessionEnvDialTarget {
  host: string;
  port: number;
  /** `http://<host>:<port>` — the preview proxy's upstream base. */
  url: string;
}

/**
 * Whether the Hub can reach the session worktree through its own filesystem.
 *
 *   - **host-shared** — the env sees the very bytes `worktree.ts` wrote, via a
 *     bind mount (or, for the host adapter, no boundary at all). Host `git`
 *     and `fs` against the worktree path are authoritative.
 *   - **env-owned** — the env holds the only live copy. Firecracker has no
 *     virtio-fs or 9p, so the worktree is *seeded onto* a block device at boot
 *     and diverges from the host directory the moment anything writes to it.
 *     The host path is a stale snapshot, and reading it is a correctness bug,
 *     not a slow path: a Finalize that committed from it would ship the seed
 *     and silently drop the session's work.
 *
 * Anything that reads or writes worktree contents must route through
 * {@link SessionEnv.worktreeIo} rather than assuming the first case.
 */
export type SessionEnvWorktreeSharing = 'host-shared' | 'env-owned';

/**
 * How a backend shares the worktree, without building (let alone starting) an
 * env. Lets a caller that only wants to read the worktree skip booting a VM or
 * container when the host copy is already authoritative.
 */
export function worktreeSharingForKind(kind: SessionEnvKind): SessionEnvWorktreeSharing {
  switch (kind) {
    case 'host':
    case 'sysbox':
    case 'container':
      return 'host-shared';
    case 'firecracker':
      return 'env-owned';
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export interface SessionEnvWorktreeMount {
  /**
   * Worktree path on the Hub host (what `worktree.ts` created), or `null`
   * under `env-owned` sharing, where no host path holds current contents.
   * Nullable on purpose: it makes the stale-snapshot case unignorable at the
   * type level instead of handing out a path that silently lies.
   */
  hostPath: string | null;
  /** The same tree as seen from inside the env (== hostPath on `host`). */
  envPath: string;
  sharing: SessionEnvWorktreeSharing;
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
   * How the Hub reaches ports inside this env. See
   * {@link SessionEnvPortRouting}.
   *
   * Callers that draw from a host-wide port pool must consult this *before*
   * allocating. Under `container-ip` nothing is published, so a pooled host
   * port is not merely wasted — it is the wrong number to dial: the process
   * binds its internal port inside the env, and that is the only port that
   * ever answers.
   */
  readonly portRouting: SessionEnvPortRouting;
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
  /**
   * Batch {@link mapPort}: resolve (allocating on first touch) every
   * internal port in `internalPorts` and return the mappings in the same
   * order. Called with no argument, returns the mappings established so far
   * (equivalent to {@link listPortMappings}). Idempotent per port. This is
   * the internal → loopback-host-port map the preview proxy repoints its
   * upstream onto — the sole off-host route into a session's ports.
   */
  mapPortsOut(internalPorts?: number[]): Promise<SessionEnvPortMapping[]>;
  /** All mappings established so far. */
  listPortMappings(): SessionEnvPortMapping[];
  /**
   * Resolve where the Hub should connect to reach `internalPort` inside the
   * env. See {@link SessionEnvDialTarget}. Adapters that route by container
   * IP accept any port at any time; adapters that publish ports resolve
   * through {@link mapPort} and inherit its pre-declaration rules.
   */
  resolveDialTarget(internalPort: number): Promise<SessionEnvDialTarget>;
  /** Ensure the session worktree is visible inside the env. Idempotent. */
  mountWorktree(): Promise<SessionEnvWorktreeMount>;
  /**
   * How this env shares the worktree with the Hub. Readable without starting
   * the env, unlike {@link mountWorktree} — callers deciding *how* to reach
   * the worktree should not have to boot a VM to find out.
   */
  readonly worktreeSharing: SessionEnvWorktreeSharing;
  /**
   * Read/write the worktree from the Hub process. The only correct way to
   * touch worktree contents: under `env-owned` sharing the host directory is
   * a boot-time snapshot, so `fs` and `git` against it read stale bytes.
   */
  readonly worktreeIo: SessionWorktreeIo;

  // ── Lifecycle / reap hooks ─────────────────────────────────────
  /** Processes + PTYs currently alive inside the env. */
  liveProcessCount(): number;
  /**
   * True when the env hosts workloads that {@link liveProcessCount} cannot
   * see (guest daemons, container services with no Hub exec/PTY handle).
   * The idle reaper must not destroy the env when this returns true.
   * Fail closed (return true) when the probe cannot run.
   */
  hasDetachedWorkload(): Promise<boolean>;
  /**
   * True when a failed {@link SessionEnvManager.ensure} must keep this entry
   * so a replacement cannot race live resources (e.g. Firecracker boot
   * failed and teardown did not complete). Default false.
   */
  retainAfterFailedEnsure(): boolean;
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
