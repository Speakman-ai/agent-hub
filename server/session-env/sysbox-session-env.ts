/**
 * Sysbox adapter — SessionEnv backed by a per-session rootless system
 * container (`sysbox-runc` runtime). The default isolation boundary on a
 * self-hosted Linux server: a real user-namespace boundary with NO
 * `--privileged` and NO host docker socket. The container entrypoint starts
 * an INNER dockerd, so the project's own `docker compose` backing services
 * (Postgres, Redis, …) run natively inside the boundary.
 *
 * Lifecycle:
 *   - The container starts lazily on the first `mountWorktree()` call (the
 *     bind mount and the loopback `-p` port publishes are fixed at `docker
 *     run` time). Callers therefore `await env.mountWorktree()` before
 *     `spawn()`/`openPty()` — spawn before start throws an actionable error
 *     rather than queueing.
 *   - Processes run via streamed `docker exec`; each records an in-container
 *     pidfile so `kill()` can signal it later. `docker rm -f` at dispose is
 *     the backstop that kills the whole namespace.
 *   - Teardown removes the container (`rm -f -v`) and its named inner-docker
 *     graph volume — the disk-growth vector — matching the finalize-runner
 *     teardown; the boot reconcile sweep (sysbox-reconcile.ts) reaps leaks.
 *
 * All IO is injectable (docker spawn, docker run, PTY factory, port
 * allocator, clock) so unit tests never touch a real daemon — the hard rule
 * from server/test/setup.ts applies to `docker` just as much as the agent
 * CLIs.
 */

import { execFile, spawn as nodeSpawn } from 'child_process';
import { stat } from 'fs/promises';
import type { HostPtyFactory, HostPtyLike, HostSpawnFn } from './host-session-env.js';
import {
  SessionEnv,
  SessionEnvClock,
  SessionEnvDisposedError,
  SessionEnvDisposeOpts,
  SessionEnvExit,
  SessionEnvPortMapping,
  SessionEnvProcess,
  SessionEnvPty,
  SessionEnvPtyOpts,
  SessionEnvSpawnOpts,
  SessionEnvWorktreeMount,
  resolveEnvRelativeCwd,
  systemSessionEnvClock,
} from './session-env.js';
import {
  SYSBOX_EXEC_USER,
  SYSBOX_SESSION_WORKSPACE,
  buildCreateSysboxGraphVolumeArgv,
  buildExecSysboxPtyArgs,
  buildExecSysboxSpawnArgv,
  buildRemoveSysboxGraphVolumeArgv,
  buildStartSysboxContainerArgv,
  buildStopSysboxContainerArgv,
  buildSysboxKillArgv,
  resolveSysboxSessionImage,
  sysboxSessionContainerName,
  sysboxSpawnPidFile,
} from './sysbox-exec-args.js';

export interface SysboxRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** One-shot docker invocation (lifecycle ops, kills). Resolves, never rejects. */
export type SysboxRunFn = (argv: string[]) => Promise<SysboxRunResult>;

const RUN_TIMEOUT_MS = 120_000;

/** Default one-shot docker runner (also used by the boot reconcile sweep). */
export function runDockerCommand(argv: string[]): Promise<SysboxRunResult> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });
}

const defaultPtyFactory: HostPtyFactory = async (opts) => {
  let mod: { spawn: (file: string, args: string[], o: object) => HostPtyLike };
  try {
    // Optional native module — same lazy-import rationale as the host adapter.
    const specifier = 'node-pty';
    mod = (await import(specifier)) as unknown as typeof mod;
  } catch (err) {
    throw new Error(
      'openPty requires the optional native module "node-pty" (npm install node-pty in server/). ' +
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

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export interface SysboxSessionEnvDeps {
  sessionId: string;
  /** The session worktree checkout as the Hub sees it (bind-mounted in). */
  worktreePath: string;
  /**
   * Internal ports to publish as `-p 127.0.0.1:<host>:<internal>` at
   * container start (docker cannot add publishes to a running container).
   * Comes from the dev-server config's `portMap`; `mapPort()` calls made
   * before the container starts extend this set.
   */
  publishPorts?: number[];
  /** Session container image. Default {@link resolveSysboxSessionImage}. */
  image?: string;
  /** Extra container env at `docker run` (image env is the base). */
  containerEnv?: Record<string, string>;
  /** Base env merged under per-spawn env for `docker exec -e`. Default {}. */
  baseEnv?: Record<string, string>;
  /** Streamed spawner for the `docker exec` client processes. */
  spawn?: HostSpawnFn;
  /** One-shot docker runner for lifecycle ops. */
  runDocker?: SysboxRunFn;
  /** PTY factory for the `docker exec -it` client. */
  openPty?: HostPtyFactory;
  /** Host-port allocator (the 4100–4999 pool in production). Default identity. */
  allocateHostPort?: (internalPort: number) => number | Promise<number>;
  releaseHostPort?: (mapping: SessionEnvPortMapping) => void;
  /** Env for the docker CLIENT processes on the host. Default process.env. */
  dockerClientEnv?: Record<string, string | undefined>;
  clock?: SessionEnvClock;
  isDirectory?: (path: string) => Promise<boolean>;
  /** Inner-dockerd readiness poll bounds. */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  logger?: { warn: (msg: string) => void };
}

const DEFAULT_DISPOSE_GRACE_MS = 5000;
const DEFAULT_READY_TIMEOUT_MS = 120_000;
const DEFAULT_READY_POLL_MS = 400;

interface LiveProcess {
  handle: SessionEnvProcess;
  exitPromise: Promise<void>;
}

interface LivePty {
  handle: SessionEnvPty;
  exitPromise: Promise<void>;
  raw: HostPtyLike;
}

export class SysboxSessionEnv implements SessionEnv {
  readonly kind = 'sysbox' as const;
  readonly sessionId: string;
  readonly createdAtMs: number;
  readonly containerName: string;

  #disposed = false;
  #disposePromise: Promise<void> | null = null;
  #lastActivityAtMs: number;
  #startPromise: Promise<void> | null = null;
  #started = false;

  private readonly worktreePath: string;
  private readonly image: string;
  private readonly containerEnv: Record<string, string>;
  private readonly baseEnv: Record<string, string>;
  private readonly spawnFn: HostSpawnFn;
  private readonly runDocker: SysboxRunFn;
  private readonly ptyFactory: HostPtyFactory;
  private readonly allocateHostPort: (internalPort: number) => number | Promise<number>;
  private readonly releaseHostPort: ((mapping: SessionEnvPortMapping) => void) | null;
  private readonly dockerClientEnv: Record<string, string | undefined>;
  private readonly clock: SessionEnvClock;
  private readonly isDirectory: (path: string) => Promise<boolean>;
  private readonly readyTimeoutMs: number;
  private readonly readyPollMs: number;
  private readonly logger: { warn: (msg: string) => void };

  /** Internal ports the container will publish (fixed once started). */
  private readonly declaredPorts: Set<number>;
  private readonly portMappings = new Map<number, Promise<SessionEnvPortMapping>>();
  private readonly settledMappings = new Map<number, SessionEnvPortMapping>();

  private readonly liveProcesses = new Set<LiveProcess>();
  private readonly livePtys = new Set<LivePty>();
  private readonly disposeHooks = new Set<() => void>();
  private spawnSeq = 0;

  constructor(deps: SysboxSessionEnvDeps) {
    this.sessionId = deps.sessionId;
    this.worktreePath = deps.worktreePath;
    this.containerName = sysboxSessionContainerName(deps.sessionId);
    this.image = deps.image ?? resolveSysboxSessionImage();
    this.containerEnv = deps.containerEnv ?? {};
    this.baseEnv = deps.baseEnv ?? {};
    this.spawnFn = deps.spawn ?? (nodeSpawn as unknown as HostSpawnFn);
    this.runDocker = deps.runDocker ?? runDockerCommand;
    this.ptyFactory = deps.openPty ?? defaultPtyFactory;
    this.allocateHostPort = deps.allocateHostPort ?? ((internalPort) => internalPort);
    this.releaseHostPort = deps.releaseHostPort ?? null;
    this.dockerClientEnv = deps.dockerClientEnv ?? process.env;
    this.clock = deps.clock ?? systemSessionEnvClock;
    this.isDirectory = deps.isDirectory ?? defaultIsDirectory;
    this.readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.readyPollMs = deps.readyPollMs ?? DEFAULT_READY_POLL_MS;
    this.logger = deps.logger ?? { warn: (msg) => console.warn(msg) };
    this.declaredPorts = new Set(deps.publishPorts ?? []);
    this.createdAtMs = this.clock.nowMs();
    this.#lastActivityAtMs = this.createdAtMs;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get lastActivityAtMs(): number {
    return this.#lastActivityAtMs;
  }

  /** True once the session container is running (spawn/openPty are usable). */
  get containerStarted(): boolean {
    return this.#started;
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

  // ── Container lifecycle ────────────────────────────────────────

  /**
   * Start the session container (idempotent). `mountWorktree()` is the
   * interface-level entry point; this is exposed for the runtime that wants
   * to warm the env explicitly.
   */
  ensureStarted(): Promise<void> {
    this.#assertLive('ensureStarted');
    if (this.#startPromise) return this.#startPromise;
    const starting = this.#doStart();
    this.#startPromise = starting;
    // A failed start must not wedge the env — allow a retry.
    starting.catch(() => {
      if (this.#startPromise === starting) this.#startPromise = null;
    });
    return starting;
  }

  async #doStart(): Promise<void> {
    if (!(await this.isDirectory(this.worktreePath))) {
      throw new Error(
        `Session worktree not found at ${this.worktreePath} (session ${this.sessionId})`,
      );
    }

    // Settle every declared port's host allocation before `docker run` —
    // publishes are fixed at container start.
    const ports = await Promise.all(
      [...this.declaredPorts]
        .sort((a, b) => a - b)
        .map(async (internalPort) => {
          const mapping = await this.mapPortPreStart(internalPort);
          return { internalPort, hostPort: mapping.hostPort };
        }),
    );

    const volume = await this.runDocker(
      buildCreateSysboxGraphVolumeArgv({
        containerName: this.containerName,
        sessionId: this.sessionId,
      }),
    );
    if (!volume.ok) {
      throw new Error(
        `Failed to create sysbox graph volume for session ${this.sessionId}: ${volume.stderr.trim() || volume.stdout.trim()}`,
      );
    }

    const run = await this.runDocker(
      buildStartSysboxContainerArgv({
        sessionId: this.sessionId,
        containerName: this.containerName,
        image: this.image,
        worktreePath: this.worktreePath,
        ports,
        env: this.containerEnv,
      }),
    );
    if (!run.ok) {
      // Best-effort cleanup so a retry does not hit name/volume collisions.
      await this.runDocker(buildStopSysboxContainerArgv(this.containerName));
      await this.runDocker(buildRemoveSysboxGraphVolumeArgv(this.containerName));
      throw new Error(
        `Failed to start sysbox session container ${this.containerName}: ${run.stderr.trim() || run.stdout.trim()}`,
      );
    }

    try {
      await this.#waitForInnerDocker();
    } catch (err) {
      // A started-but-unready container is not usable and would make the
      // retry hit a name collision. Remove both resources before surfacing
      // the readiness error; the boot reconcile remains the crash backstop.
      await this.runDocker(buildStopSysboxContainerArgv(this.containerName));
      await this.runDocker(buildRemoveSysboxGraphVolumeArgv(this.containerName));
      throw err;
    }
    this.#started = true;
    this.touch();
  }

  /**
   * Poll the INNER dockerd until it answers — the project's own
   * `docker compose up` runs against it immediately after boot.
   */
  async #waitForInnerDocker(): Promise<void> {
    const deadline = this.clock.nowMs() + this.readyTimeoutMs;
    const probeArgv = [
      'docker',
      'exec',
      '-u',
      SYSBOX_EXEC_USER,
      this.containerName,
      'docker',
      'info',
    ];
    for (;;) {
      if ((await this.runDocker(probeArgv)).ok) return;
      if (this.clock.nowMs() >= deadline) {
        throw new Error(
          `Inner dockerd in ${this.containerName} not ready after ${this.readyTimeoutMs}ms`,
        );
      }
      await this.clock.sleep(this.readyPollMs);
    }
  }

  // ── SessionEnv ops ─────────────────────────────────────────────

  spawn(command: string, opts: SessionEnvSpawnOpts = {}): SessionEnvProcess {
    this.#assertLive('spawn');
    if (!this.#started) {
      throw new Error(
        `Sysbox session container for ${this.sessionId} is not started — ` +
          'await mountWorktree() (or ensureStarted()) before spawn().',
      );
    }
    const cwd = resolveEnvRelativeCwd(SYSBOX_SESSION_WORKSPACE, opts.cwd);
    const name = opts.name ?? command;
    const pidFile = sysboxSpawnPidFile(this.spawnSeq++);
    const argv = buildExecSysboxSpawnArgv({
      containerName: this.containerName,
      command,
      cwd,
      env: { ...this.baseEnv, ...opts.env },
      pidFile,
    });
    // The docker exec CLIENT runs on the host; its exit mirrors the
    // in-container process exit (docker exec propagates the exit code).
    const child = this.spawnFn(argv[0], argv.slice(1), {
      cwd: this.worktreePath,
      env: this.dockerClientEnv,
      detached: false,
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

    const kill = (signal: NodeJS.Signals = 'SIGTERM') => {
      if (exitResult !== null) return;
      // Signal the IN-CONTAINER process via its pidfile — killing the exec
      // client would orphan the inner process, not stop it.
      void this.runDocker(
        buildSysboxKillArgv({ containerName: this.containerName, pidFile, signal }),
      ).then((res) => {
        if (!res.ok) {
          this.logger.warn(
            `SessionEnv[${this.sessionId}] kill(${signal}) of "${name}" failed: ${res.stderr.trim()}`,
          );
        }
      });
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
      kill,
    };

    const live: LiveProcess = { handle, exitPromise };
    if (exitResult === null) this.liveProcesses.add(live);
    return handle;
  }

  async openPty(opts: SessionEnvPtyOpts = {}): Promise<SessionEnvPty> {
    this.#assertLive('openPty');
    await this.ensureStarted();
    this.#assertLive('openPty');
    const cwd = resolveEnvRelativeCwd(SYSBOX_SESSION_WORKSPACE, opts.cwd);
    const ptyArgs = buildExecSysboxPtyArgs({
      containerName: this.containerName,
      command: opts.command,
      args: opts.args,
      cwd,
      env: { ...this.baseEnv, TERM: opts.name ?? 'xterm-256color', ...opts.env },
    });
    const clientEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.dockerClientEnv)) {
      if (v !== undefined) clientEnv[k] = v;
    }
    const raw = await this.ptyFactory({
      command: 'docker',
      args: ptyArgs,
      cwd: this.worktreePath,
      env: clientEnv,
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
    if (this.#started || this.#startPromise) {
      // Publishes are fixed at `docker run` — an undeclared port cannot be
      // added to a running container.
      return Promise.reject(
        new Error(
          `Port ${internalPort} was not declared before the sysbox session container started. ` +
            'Add it to the dev-server portMap (or pass it in publishPorts) and restart the session env.',
        ),
      );
    }
    return this.mapPortPreStart(internalPort);
  }

  private mapPortPreStart(internalPort: number): Promise<SessionEnvPortMapping> {
    const existing = this.portMappings.get(internalPort);
    if (existing) return existing;
    this.declaredPorts.add(internalPort);
    const mapping = Promise.resolve()
      .then(() => this.allocateHostPort(internalPort))
      .then((hostPort) => {
        const resolved: SessionEnvPortMapping = {
          internalPort,
          hostPort,
          // Container translation publishes hostPort → internalPort, so the
          // in-container process must bind the internal side of the mapping.
          envPort: internalPort,
          // Loopback only — published as `-p 127.0.0.1:<host>:<internal>`.
          hostUrl: `http://127.0.0.1:${hostPort}`,
        };
        this.settledMappings.set(internalPort, resolved);
        return resolved;
      });
    this.portMappings.set(internalPort, mapping);
    mapping.catch(() => {
      // A failed allocation must not poison the cache for retries.
      this.portMappings.delete(internalPort);
      this.declaredPorts.delete(internalPort);
    });
    return mapping;
  }

  async mapPortsOut(internalPorts?: number[]): Promise<SessionEnvPortMapping[]> {
    if (internalPorts === undefined) return this.listPortMappings();
    // Idempotent per internal port: repeated ports collapse to one publish
    // while the result keeps input order. All ports must be declared before
    // the container starts — `mapPort` rejects an undeclared port post-start.
    return Promise.all(internalPorts.map((p) => this.mapPort(p)));
  }

  listPortMappings(): SessionEnvPortMapping[] {
    return [...this.settledMappings.values()];
  }

  async mountWorktree(): Promise<SessionEnvWorktreeMount> {
    this.#assertLive('mountWorktree');
    // The bind mount happens at container start; ensureStarted is idempotent.
    await this.ensureStarted();
    this.#assertLive('mountWorktree');
    return { hostPath: this.worktreePath, envPath: SYSBOX_SESSION_WORKSPACE };
  }

  dispose(opts: SessionEnvDisposeOpts = {}): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise;
    this.#disposePromise = this.#doDispose(opts.graceMs ?? DEFAULT_DISPOSE_GRACE_MS);
    return this.#disposePromise;
  }

  async #doDispose(graceMs: number): Promise<void> {
    this.#disposed = true;
    const started = this.#started || this.#startPromise !== null;
    if (this.#startPromise) {
      // Never race teardown against a start still in flight.
      await this.#startPromise.catch(() => {});
    }

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
      await Promise.race([allExited, timedOut]);
      // No per-process SIGKILL pass: removing the container SIGKILLs every
      // process in the namespace — a stronger guarantee than the host path.
    }

    if (started) {
      const rm = await this.runDocker(buildStopSysboxContainerArgv(this.containerName));
      if (!rm.ok) {
        this.logger.warn(
          `SessionEnv[${this.sessionId}] container removal failed: ${rm.stderr.trim()}`,
        );
      }
      // After the container is gone the named graph volume is unreferenced.
      const vol = await this.runDocker(buildRemoveSysboxGraphVolumeArgv(this.containerName));
      if (!vol.ok) {
        this.logger.warn(
          `SessionEnv[${this.sessionId}] graph volume removal failed: ${vol.stderr.trim()}`,
        );
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
