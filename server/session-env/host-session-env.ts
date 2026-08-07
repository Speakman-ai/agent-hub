/**
 * Host adapter — SessionEnv backed by direct host processes.
 *
 * The local-dev/Mac path and the fast fallback on any OS with Node. No
 * container boundary: processes run as the Hub user, the worktree is used
 * in place, and internal ports ARE host ports (bound loopback-only by the
 * dev server itself via the injected `PORT`).
 *
 * All IO is injectable (`spawn`, PTY factory, `kill`, port allocator,
 * clock, fs probe) so unit tests never touch real processes — same pattern
 * as `preview/dev-server-runtime.ts`.
 */

import { spawn as nodeSpawn } from 'child_process';
import { stat } from 'fs/promises';
import {
  SessionEnv,
  SessionEnvClock,
  SessionEnvDisposedError,
  SessionEnvDisposeOpts,
  SessionEnvExit,
  SessionEnvDialTarget,
  SessionEnvPortMapping,
  SessionEnvProcess,
  SessionEnvPty,
  SessionEnvPtyOpts,
  SessionEnvSpawnOpts,
  SessionEnvWorktreeMount,
  resolveEnvRelativeCwd,
  systemSessionEnvClock,
} from './session-env.js';

/**
 * Minimal `child_process.spawn`-shaped child. Keeps the adapter decoupled
 * from the real Node import so tests inject a fake without
 * `vi.mock('child_process', …)`.
 */
export interface HostChildLike {
  pid?: number;
  stdout?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type HostSpawnFn = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: Record<string, string | undefined>;
    detached: boolean;
    stdio: ['ignore', 'pipe', 'pipe'];
  },
) => HostChildLike;

/** node-pty's `IPty` surface, kept structural so tests inject a fake. */
export interface HostPtyLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  kill(signal?: string): void;
}

export type HostPtyFactory = (opts: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  name: string;
}) => Promise<HostPtyLike>;

export interface HostSessionEnvDeps {
  sessionId: string;
  /** The session worktree checkout on the host (created by `worktree.ts`). */
  worktreePath: string;
  spawn?: HostSpawnFn;
  /**
   * PTY factory. Defaults to a lazy `import('node-pty')` so the native
   * module is loaded only when a terminal is opened.
   */
  openPty?: HostPtyFactory;
  /** Signal a pid (negative pid = process group). Default `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /**
   * Host-port allocator for `mapPort`. Defaults to identity (the process
   * binds the internal port directly on the host) — the pool-backed
   * allocator (4100–4999) is wired in by the dev-server runtime.
   */
  allocateHostPort?: (internalPort: number) => number | Promise<number>;
  /** Invoked once per mapping on dispose so pooled ports return to the pool. */
  releaseHostPort?: (mapping: SessionEnvPortMapping) => void;
  /** Base env for spawned processes/PTYs. Default `process.env`. */
  baseEnv?: Record<string, string | undefined>;
  clock?: SessionEnvClock;
  /** Directory-exists probe for `mountWorktree`. Default `fs.stat`. */
  isDirectory?: (path: string) => Promise<boolean>;
  logger?: { warn: (msg: string) => void };
}

const DEFAULT_DISPOSE_GRACE_MS = 5000;

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

const defaultPtyFactory: HostPtyFactory = async (opts) => {
  let mod: { spawn: (file: string, args: string[], o: object) => HostPtyLike };
  try {
    // Keep the import lazy so Hub boot does not load the native binding when
    // the Terminal surface is unused.
    const specifier = 'node-pty';
    mod = (await import(specifier)) as unknown as typeof mod;
  } catch (err) {
    throw new Error(
      'openPty requires the native module "node-pty" (install the server dependencies). ' +
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return mod.spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols,
    rows: opts.rows,
    name: opts.name,
  });
};

interface LiveProcess {
  handle: SessionEnvProcess;
  exitPromise: Promise<void>;
}

interface LivePty {
  handle: SessionEnvPty;
  exitPromise: Promise<void>;
  raw: HostPtyLike;
}

export class HostSessionEnv implements SessionEnv {
  readonly kind = 'host' as const;
  /**
   * There is no boundary to cross, so a port is reached on the host directly.
   * That is the same contract as publishing — the Hub dials a host port the
   * process is expected to bind — which keeps pool allocation in play here.
   */
  readonly portRouting = 'published-ports' as const;
  readonly sessionId: string;
  readonly createdAtMs: number;

  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #lastActivityAtMs: number;

  private readonly worktreePath: string;
  private readonly spawnFn: HostSpawnFn;
  private readonly ptyFactory: HostPtyFactory;
  private readonly killFn: (pid: number, signal: NodeJS.Signals) => void;
  private readonly allocateHostPort: (internalPort: number) => number | Promise<number>;
  private readonly releaseHostPort: ((mapping: SessionEnvPortMapping) => void) | null;
  private readonly baseEnv: Record<string, string | undefined>;
  private readonly clock: SessionEnvClock;
  private readonly isDirectory: (path: string) => Promise<boolean>;
  private readonly logger: { warn: (msg: string) => void };

  private readonly liveProcesses = new Set<LiveProcess>();
  private readonly livePtys = new Set<LivePty>();
  private readonly portMappings = new Map<number, Promise<SessionEnvPortMapping>>();
  private readonly settledMappings = new Map<number, SessionEnvPortMapping>();
  private readonly disposeHooks = new Set<() => void>();

  constructor(deps: HostSessionEnvDeps) {
    this.sessionId = deps.sessionId;
    this.worktreePath = deps.worktreePath;
    this.spawnFn = deps.spawn ?? (nodeSpawn as unknown as HostSpawnFn);
    this.ptyFactory = deps.openPty ?? defaultPtyFactory;
    this.killFn = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    this.allocateHostPort = deps.allocateHostPort ?? ((internalPort) => internalPort);
    this.releaseHostPort = deps.releaseHostPort ?? null;
    this.baseEnv = deps.baseEnv ?? process.env;
    this.clock = deps.clock ?? systemSessionEnvClock;
    this.isDirectory = deps.isDirectory ?? defaultIsDirectory;
    this.logger = deps.logger ?? { warn: (msg) => console.warn(msg) };
    this.createdAtMs = this.clock.nowMs();
    this.#lastActivityAtMs = this.createdAtMs;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get lastActivityAtMs(): number {
    return this.#lastActivityAtMs;
  }

  touch(): void {
    this.#lastActivityAtMs = this.clock.nowMs();
  }

  liveProcessCount(): number {
    return this.liveProcesses.size + this.livePtys.size;
  }

  onDispose(cb: () => void): () => void {
    this.disposeHooks.add(cb);
    return () => this.disposeHooks.delete(cb);
  }

  spawn(command: string, opts: SessionEnvSpawnOpts = {}): SessionEnvProcess {
    this.#assertLive('spawn');
    const cwd = resolveEnvRelativeCwd(this.worktreePath, opts.cwd);
    const name = opts.name ?? command;
    const child = this.spawnFn('sh', ['-c', command], {
      cwd,
      env: { ...this.baseEnv, ...opts.env },
      // Own process group so kill(-pid) reaps the whole dev-server tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.touch();

    const stdoutSubs = new Set<(chunk: string) => void>();
    const stderrSubs = new Set<(chunk: string) => void>();
    const exitSubs = new Set<(result: SessionEnvExit) => void>();
    let exitResult: SessionEnvExit | null = null;

    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });

    const settle = (result: SessionEnvExit) => {
      if (exitResult !== null) return;
      exitResult = result;
      this.liveProcesses.delete(live);
      for (const cb of exitSubs) {
        try {
          cb(result);
        } catch (err) {
          this.logger.warn(`SessionEnv[${this.sessionId}] onExit hook threw: ${String(err)}`);
        }
      }
      resolveExit();
    };

    child.stdout?.on('data', (chunk) => {
      this.touch();
      const text = chunk.toString();
      for (const cb of stdoutSubs) cb(text);
    });
    child.stderr?.on('data', (chunk) => {
      this.touch();
      const text = chunk.toString();
      for (const cb of stderrSubs) cb(text);
    });
    child.on('exit', (code, signal) => settle({ code, signal }));
    child.on('error', (error) => settle({ code: null, signal: null, error }));

    const killTree = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (exitResult !== null || child.pid === undefined) return;
      try {
        this.killFn(-child.pid, signal);
      } catch {
        try {
          this.killFn(child.pid, signal);
        } catch {
          // Already gone — the exit handler settles state.
        }
      }
    };

    const handle: SessionEnvProcess = {
      pid: child.pid ?? null,
      name,
      get exited() {
        return exitResult !== null;
      },
      get exitResult() {
        return exitResult;
      },
      onStdout: (cb) => {
        stdoutSubs.add(cb);
        return () => stdoutSubs.delete(cb);
      },
      onStderr: (cb) => {
        stderrSubs.add(cb);
        return () => stderrSubs.delete(cb);
      },
      onExit: (cb) => {
        if (exitResult !== null) {
          cb(exitResult);
          return () => {};
        }
        exitSubs.add(cb);
        return () => exitSubs.delete(cb);
      },
      kill: killTree,
    };

    const live: LiveProcess = { handle, exitPromise };
    if (exitResult === null) this.liveProcesses.add(live);
    return handle;
  }

  async openPty(opts: SessionEnvPtyOpts = {}): Promise<SessionEnvPty> {
    this.#assertLive('openPty');
    const cwd = resolveEnvRelativeCwd(this.worktreePath, opts.cwd);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...this.baseEnv, ...opts.env })) {
      if (v !== undefined) env[k] = v;
    }
    const raw = await this.ptyFactory({
      // Keep the standalone host terminal useful when the service environment
      // does not define SHELL. Dash accepts a PTY but does not provide line
      // history or completion, so the fallback must be a line-editing shell.
      command: opts.command ?? this.baseEnv.SHELL ?? '/bin/bash',
      args: opts.args ?? [],
      cwd,
      env,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      name: opts.name ?? 'xterm-256color',
    });
    this.#assertLive('openPty', () => raw.kill());
    this.touch();

    let exited = false;
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>((r) => {
      resolveExit = r;
    });
    raw.onData(() => this.touch());
    raw.onExit(() => {
      exited = true;
      this.livePtys.delete(live);
      resolveExit();
    });

    const handle: SessionEnvPty = {
      pid: raw.pid,
      write: (data) => {
        this.touch();
        raw.write(data);
      },
      resize: (cols, rows) => raw.resize(cols, rows),
      onData: (cb) => {
        const sub = raw.onData(cb);
        return () => sub.dispose();
      },
      onExit: (cb) => {
        const sub = raw.onExit(cb);
        return () => sub.dispose();
      },
      kill: (signal) => raw.kill(signal),
    };

    const live: LivePty = { handle, exitPromise, raw };
    if (!exited) this.livePtys.add(live);
    return handle;
  }

  mapPort(internalPort: number): Promise<SessionEnvPortMapping> {
    this.#assertLive('mapPort');
    const existing = this.portMappings.get(internalPort);
    if (existing) return existing;
    // `.then()` wrapping (vs `Promise.resolve(call)`) turns a synchronously
    // throwing allocator into a rejection instead of a sync throw.
    const mapping = Promise.resolve()
      .then(() => this.allocateHostPort(internalPort))
      .then((hostPort) => {
        const resolved: SessionEnvPortMapping = {
          internalPort,
          host: '127.0.0.1',
          hostPort,
          // No translation on the host adapter — the process binds the
          // allocated host port directly (steered via the injected PORT).
          envPort: hostPort,
          // Loopback only — the preview proxy is the sole off-host route in.
          hostUrl: `http://127.0.0.1:${hostPort}`,
        };
        this.settledMappings.set(internalPort, resolved);
        return resolved;
      });
    this.portMappings.set(internalPort, mapping);
    // A failed allocation must not poison the cache for retries.
    mapping.catch(() => this.portMappings.delete(internalPort));
    return mapping;
  }

  async mapPortsOut(internalPorts?: number[]): Promise<SessionEnvPortMapping[]> {
    if (internalPorts === undefined) return this.listPortMappings();
    // `mapPort` is idempotent + caches per internal port, so duplicates in
    // the input collapse to one allocation while the result preserves order.
    return Promise.all(internalPorts.map((p) => this.mapPort(p)));
  }

  listPortMappings(): SessionEnvPortMapping[] {
    return [...this.settledMappings.values()];
  }

  /**
   * Loopback, always: host processes bind directly on the host, so there is
   * no boundary between the Hub and the port.
   */
  async resolveDialTarget(internalPort: number): Promise<SessionEnvDialTarget> {
    this.#assertLive('resolveDialTarget');
    const mapping = await this.mapPort(internalPort);
    return {
      host: '127.0.0.1',
      port: mapping.hostPort,
      url: `http://127.0.0.1:${mapping.hostPort}`,
    };
  }

  async mountWorktree(): Promise<SessionEnvWorktreeMount> {
    this.#assertLive('mountWorktree');
    if (!(await this.isDirectory(this.worktreePath))) {
      throw new Error(
        `Session worktree not found at ${this.worktreePath} (session ${this.sessionId})`,
      );
    }
    // Host adapter uses the worktree in place — no bind mount needed.
    return { hostPath: this.worktreePath, envPath: this.worktreePath };
  }

  dispose(opts: SessionEnvDisposeOpts = {}): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#doDispose(opts.graceMs ?? DEFAULT_DISPOSE_GRACE_MS);
    return this.#disposePromise;
  }

  async #doDispose(graceMs: number): Promise<void> {
    this.#disposed = true;
    const procs = [...this.liveProcesses];
    const ptys = [...this.livePtys];
    for (const p of procs) p.handle.kill('SIGTERM');
    for (const p of ptys) {
      try {
        p.handle.kill();
      } catch {
        // PTY may have raced to exit.
      }
    }

    if (procs.length > 0 || ptys.length > 0) {
      const allExited = Promise.all([...procs, ...ptys].map((p) => p.exitPromise)).then(
        () => 'exited' as const,
      );
      const timedOut = this.clock.sleep(graceMs).then(() => 'timeout' as const);
      if ((await Promise.race([allExited, timedOut])) === 'timeout') {
        for (const p of [...this.liveProcesses]) p.handle.kill('SIGKILL');
        for (const p of [...this.livePtys]) {
          try {
            p.handle.kill('SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }
    }

    for (const pending of this.portMappings.values()) {
      try {
        const mapping = await pending;
        this.releaseHostPort?.(mapping);
      } catch {
        // Allocation failed — nothing to release.
      }
    }
    this.portMappings.clear();
    this.settledMappings.clear();

    for (const hook of this.disposeHooks) {
      try {
        hook();
      } catch (err) {
        this.logger.warn(`SessionEnv[${this.sessionId}] dispose hook threw: ${String(err)}`);
      }
    }
    this.disposeHooks.clear();
  }

  #assertLive(op: string, cleanup?: () => void): void {
    if (this.#disposed) {
      try {
        cleanup?.();
      } catch {
        // Best-effort cleanup of resources created during a dispose race.
      }
      throw new SessionEnvDisposedError(this.sessionId, op);
    }
  }
}
