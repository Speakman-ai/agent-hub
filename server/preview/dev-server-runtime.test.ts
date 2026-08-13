/**
 * DevServerRuntime lifecycle tests.
 *
 * Every process and SessionEnv boundary is faked. No test in this file
 * spawns a real dev server (or any child process).
 */

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types.js';
import type {
  SessionEnv,
  SessionEnvDisposeOpts,
  SessionEnvExit,
  SessionEnvDialTarget,
  SessionEnvKind,
  SessionEnvPortMapping,
  SessionEnvProcess,
  SessionEnvPty,
  SessionEnvPtyOpts,
  SessionEnvSpawnOpts,
  SessionEnvWorktreeMount,
} from '../session-env/session-env.js';
import type { SessionEnvPortRouting } from '../session-env/container-routing.js';
import { HostWorktreeIo, type SessionWorktreeIo } from '../session-env/worktree-io.js';
import type { Clock } from './preview-runtime-primitives.js';
import { resolveDevServerPortClientUrl } from './preview-public-url.js';
import {
  buildDevServerSpawnEnv,
  DevServerRuntime,
  resolveDevServerPortEntries,
  uniquePortEntryNames,
  type CreateDevServerEnvFn,
  type ResolveSharedSessionEnvFn,
  type DevServerNotifyLogFn,
  type DevServerNotifyStatusFn,
} from './dev-server-runtime.js';

class FakeClock implements Clock {
  now = 0;

  nowMs(): number {
    return this.now;
  }

  nowIso(): string {
    return new Date(this.now).toISOString();
  }

  sleep(ms: number): Promise<void> {
    this.now += ms;
    return Promise.resolve();
  }
}

class FakeProcess implements SessionEnvProcess {
  readonly pid: number;
  readonly name: string;
  exited = false;
  exitResult: SessionEnvExit | null = null;
  killCalls: NodeJS.Signals[] = [];
  private readonly stdout = new Set<(chunk: string) => void>();
  private readonly stderr = new Set<(chunk: string) => void>();
  private readonly exits = new Set<(result: SessionEnvExit) => void>();

  constructor(pid: number, name: string) {
    this.pid = pid;
    this.name = name;
  }

  onStdout(cb: (chunk: string) => void): () => void {
    this.stdout.add(cb);
    return () => this.stdout.delete(cb);
  }

  onStderr(cb: (chunk: string) => void): () => void {
    this.stderr.add(cb);
    return () => this.stderr.delete(cb);
  }

  onExit(cb: (result: SessionEnvExit) => void): () => void {
    if (this.exitResult) cb(this.exitResult);
    else this.exits.add(cb);
    return () => this.exits.delete(cb);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.killCalls.push(signal);
    this.exit({ code: null, signal });
  }

  emitStdout(chunk: string): void {
    for (const cb of this.stdout) cb(chunk);
  }

  emitStderr(chunk: string): void {
    for (const cb of this.stderr) cb(chunk);
  }

  exit(result: SessionEnvExit): void {
    if (this.exited) return;
    this.exited = true;
    this.exitResult = result;
    for (const cb of this.exits) cb(result);
  }
}

class FakeSessionEnv implements SessionEnv {
  kind: SessionEnvKind = 'host';
  portRouting: SessionEnvPortRouting = 'published-ports';
  /** Overridden by container-env tests to assert per-session upstream hosts. */
  dialHost = '127.0.0.1';
  readonly sessionId: string;
  readonly createdAtMs = 0;
  lastActivityAtMs = 0;
  disposed = false;
  mountCalls = 0;
  disposeCalls: SessionEnvDisposeOpts[] = [];
  spawnCalls: Array<{ command: string; opts: SessionEnvSpawnOpts }> = [];
  mapCalls: number[] = [];
  proc: FakeProcess | null = null;
  throwOnSpawn: Error | null = null;
  /** When set, the NEXT spawned proc is created already-exited with this result. */
  preExitNextSpawn: SessionEnvExit | null = null;
  readonly worktreeSharing = 'host-shared' as const;
  readonly worktreeIo: SessionWorktreeIo = new HostWorktreeIo('/fake/worktree');
  private readonly mappings = new Map<number, SessionEnvPortMapping>();
  private readonly disposeHooks = new Set<() => void>();

  constructor(
    sessionId: string,
    private readonly allocateHostPort: (internalPort: number) => number,
    private readonly resolveEnvPort: (internalPort: number, hostPort: number) => number = (
      _internalPort,
      hostPort,
    ) => hostPort,
  ) {
    this.sessionId = sessionId;
  }

  spawn(command: string, opts: SessionEnvSpawnOpts = {}): SessionEnvProcess {
    if (this.throwOnSpawn) throw this.throwOnSpawn;
    this.spawnCalls.push({ command, opts });
    const proc = new FakeProcess(7000 + this.spawnCalls.length, opts.name ?? command);
    if (this.preExitNextSpawn) {
      // Pre-exit BEFORE any listener attaches, so a later onExit fires
      // synchronously — the already-exited contract the runner must handle.
      proc.exit(this.preExitNextSpawn);
      this.preExitNextSpawn = null;
    }
    this.proc = proc;
    return proc;
  }

  openPty(_opts?: SessionEnvPtyOpts): Promise<SessionEnvPty> {
    throw new Error('not used by DevServerRuntime');
  }

  async resolveDialTarget(internalPort: number): Promise<SessionEnvDialTarget> {
    const mapping = await this.mapPort(internalPort);
    return { host: mapping.host, port: mapping.hostPort, url: mapping.hostUrl };
  }

  async mapPort(internalPort: number): Promise<SessionEnvPortMapping> {
    this.mapCalls.push(internalPort);
    const existing = this.mappings.get(internalPort);
    if (existing) return existing;
    const hostPort = this.allocateHostPort(internalPort);
    const mapping = {
      internalPort,
      host: this.dialHost,
      hostPort,
      envPort: this.resolveEnvPort(internalPort, hostPort),
      hostUrl: `http://${this.dialHost}:${hostPort}`,
    };
    this.mappings.set(internalPort, mapping);
    return mapping;
  }

  async mapPortsOut(internalPorts?: number[]): Promise<SessionEnvPortMapping[]> {
    if (internalPorts === undefined) return this.listPortMappings();
    return Promise.all(internalPorts.map((p) => this.mapPort(p)));
  }

  listPortMappings(): SessionEnvPortMapping[] {
    return [...this.mappings.values()];
  }

  async mountWorktree(): Promise<SessionEnvWorktreeMount> {
    this.mountCalls++;
    return { hostPath: '/worktree', envPath: '/worktree', sharing: this.worktreeSharing };
  }

  liveProcessCount(): number {
    return this.proc && !this.proc.exited ? 1 : 0;
  }

  async hasDetachedWorkload(): Promise<boolean> {
    return false;
  }

  retainAfterFailedEnsure(): boolean {
    return false;
  }

  touch(): void {
    this.lastActivityAtMs++;
  }

  onDispose(cb: () => void): () => void {
    this.disposeHooks.add(cb);
    return () => this.disposeHooks.delete(cb);
  }

  async dispose(opts: SessionEnvDisposeOpts = {}): Promise<void> {
    this.disposeCalls.push(opts);
    if (this.disposed) return;
    this.disposed = true;
    if (this.proc && !this.proc.exited) this.proc.kill('SIGTERM');
    for (const cb of this.disposeHooks) cb();
  }
}

interface Harness {
  runtime: DevServerRuntime;
  db: Database.Database;
  clock: FakeClock;
  envs: FakeSessionEnv[];
  fetch: ReturnType<typeof vi.fn>;
  loadProjectEnv: ReturnType<typeof vi.fn>;
}

function makeProject(
  devServer: Record<string, unknown> = {},
  preview: Record<string, unknown> = {},
): Project {
  return {
    id: 'project-1',
    name: 'Project One',
    cwd: '/repo',
    ahw: '/repo',
    agents: [],
    prEnv: {
      enabled: false,
      devServer,
      preview: { enabled: true, ...preview },
    },
  } as unknown as Project;
}

function makeHarness(
  opts: {
    fetchOk?: boolean;
    /** Full fetch override — wins over `fetchOk`. */
    fetchImpl?: (url: string) => Promise<{ ok: boolean; status: number }>;
    envSetup?: (env: FakeSessionEnv) => void;
    createEnvError?: Error;
    resolveEnvPort?: (internalPort: number, hostPort: number) => number;
    getProject?: (projectId: string) => Project | null;
    portRange?: { min: number; max: number };
    /** Injected so a test's `fetchImpl` can close over the same clock. */
    clock?: FakeClock;
    readyTimeoutMs?: number;
    logTailLines?: number;
    notifyLog?: DevServerNotifyLogFn;
    notifyStatus?: DevServerNotifyStatusFn;
    portClientUrl?: (args: {
      sessionId: string;
      hostPort: number;
      internalPort: number;
      primary: boolean;
    }) => string;
    isPortFree?: (port: number) => Promise<boolean>;
    kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
    resolveSharedEnv?: ResolveSharedSessionEnvFn;
    /** Stands in for AGENT_HUB_PREVIEW_HEALTH_HOST on a dockerized Hub. */
    healthUrlBase?: (port: number) => string;
  } = {},
): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const clock = opts.clock ?? new FakeClock();
  const envs: FakeSessionEnv[] = [];
  const createEnv: CreateDevServerEnvFn = ({ sessionId, allocateHostPort }) => {
    if (opts.createEnvError) throw opts.createEnvError;
    const env = new FakeSessionEnv(sessionId, allocateHostPort, opts.resolveEnvPort);
    opts.envSetup?.(env);
    envs.push(env);
    return env;
  };
  const fetch = opts.fetchImpl
    ? vi.fn(opts.fetchImpl)
    : vi.fn().mockResolvedValue({ ok: opts.fetchOk ?? true, status: 200 });
  const loadProjectEnv = vi
    .fn()
    .mockReturnValue({ TOKEN: 'secret-value', UNUSED: 'do-not-inject' });
  const runtime = new DevServerRuntime({
    db,
    createEnv,
    fetch,
    clock,
    // Hermetic by default: the real probe binds sockets, which would make
    // allocation depend on whatever else is running on the dev machine.
    isPortFree: opts.isPortFree ?? (async () => true),
    ...(opts.kill ? { kill: opts.kill } : {}),
    ...(opts.resolveSharedEnv ? { resolveSharedEnv: opts.resolveSharedEnv } : {}),
    loadProjectEnv,
    getProject: opts.getProject,
    notifyLog: opts.notifyLog,
    notifyStatus: opts.notifyStatus,
    config: {
      portRange: opts.portRange ?? { min: 4500, max: 4502 },
      readyTimeoutMs: opts.readyTimeoutMs ?? 2,
      healthIntervalMs: 1,
      disposeGraceMs: 25,
      ...(opts.logTailLines !== undefined ? { logTailLines: opts.logTailLines } : {}),
      urlBase: (port, sessionId) => `/api/sessions/${sessionId}/preview/proxy/${port}`,
      ...(opts.portClientUrl ? { portClientUrl: opts.portClientUrl } : {}),
      ...(opts.healthUrlBase ? { healthUrlBase: opts.healthUrlBase } : {}),
    },
    logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  return { runtime, db, clock, envs, fetch, loadProjectEnv };
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe('DevServerRuntime helpers', () => {
  it('builds env from plain config + referenced secrets and reserves PORT for the runtime', () => {
    const result = buildDevServerSpawnEnv({
      config: {
        startCommand: 'npm run dev',
        env: { APP_MODE: 'development' },
        secretKeys: ['TOKEN', 'MISSING'],
        portMap: [],
        aptPackages: [],
      },
      projectSecrets: { TOKEN: 'shh', UNUSED: 'not-selected' },
      envPort: 4510,
    });

    expect(result).toEqual({
      env: {
        APP_MODE: 'development',
        TOKEN: 'shh',
        // Dev-install defaults keep the Hub's NODE_ENV=production out of the
        // dev server's `npm ci` so devDependencies (build tooling) install.
        NODE_ENV: 'development',
        NPM_CONFIG_INCLUDE: 'dev',
        PORT: '4510',
      },
      missingSecretKeys: ['MISSING'],
    });
  });

  it('lets an explicit dev-server env override the dev-install defaults', () => {
    const result = buildDevServerSpawnEnv({
      config: {
        startCommand: 'npm run dev',
        env: { NPM_CONFIG_INCLUDE: 'optional' },
        secretKeys: [],
        portMap: [],
        aptPackages: [],
      },
      projectSecrets: {},
      envPort: 4600,
    });

    // Project-configured NPM_CONFIG_INCLUDE is preserved; NODE_ENV (a reserved
    // key the project can never set) still defaults to development.
    expect(result.env.NPM_CONFIG_INCLUDE).toBe('optional');
    expect(result.env.NODE_ENV).toBe('development');
  });

  describe('upstream host for the dev server allowlist', () => {
    const config = {
      startCommand: 'npm run dev',
      env: {} as Record<string, string>,
      secretKeys: [],
      portMap: [],
      aptPackages: [],
    };

    it('names the host the proxy will send, so a host-gated dev server allows it', () => {
      // A container address is assigned at create time, so it cannot be in any
      // committed config. Vite rejects an unknown Host with a 403 — after the
      // readiness probe passed, because the probe sends `Host: localhost`. The
      // preview then reports ready and shows an error page.
      const result = buildDevServerSpawnEnv({
        config,
        projectSecrets: {},
        envPort: 4200,
        upstreamHost: '172.17.0.9',
      });
      expect(result.env.AGENT_HUB_PREVIEW_HEALTH_HOST).toBe('172.17.0.9');
    });

    it('leaves a host pinned in devServer.env alone', () => {
      const result = buildDevServerSpawnEnv({
        config: { ...config, env: { AGENT_HUB_PREVIEW_HEALTH_HOST: 'gateway.internal' } },
        projectSecrets: {},
        envPort: 4200,
        upstreamHost: '172.17.0.9',
      });
      expect(result.env.AGENT_HUB_PREVIEW_HEALTH_HOST).toBe('gateway.internal');
    });

    it('says nothing when there is no host to name', () => {
      // Loopback mappings resolve through the Hub-wide default, which knows
      // about gateway translation; naming a side here would override it.
      for (const upstreamHost of [null, undefined, '  ']) {
        const result = buildDevServerSpawnEnv({
          config,
          projectSecrets: {},
          envPort: 4200,
          upstreamHost,
        });
        expect(result.env).not.toHaveProperty('AGENT_HUB_PREVIEW_HEALTH_HOST');
      }
    });
  });

  it('normalizes a primary port and disambiguates duplicate labels', () => {
    const entries = resolveDevServerPortEntries({
      startCommand: 'npm run dev',
      env: {},
      secretKeys: [],
      aptPackages: [],
      portMap: [
        { internalPort: 3000, label: 'web' },
        { internalPort: 3001, label: 'web' },
      ],
    });
    expect(entries[0].primary).toBe(true);
    expect(uniquePortEntryNames(entries)).toEqual(['web:3000', 'web:3001']);
  });
});

describe('DevServerRuntime lifecycle', () => {
  it('mounts, maps, spawns in the configured cwd, injects secrets, persists pid, and becomes ready', async () => {
    const h = makeHarness();
    const project = makeProject({
      startCommand: 'npm run dev -- --host 127.0.0.1',
      cwd: 'client',
      env: { APP_MODE: 'development' },
      secretKeys: ['TOKEN'],
      portMap: [{ internalPort: 5173, label: 'web', primary: true }],
      healthPath: '/healthz',
    });

    const started = await h.runtime.start('session-1', project, '/worktree');
    await flushMicrotasks();

    expect(started).toEqual({
      devServerId: expect.any(String),
      port: 4500,
      url: '/api/sessions/session-1/preview/proxy/4500',
    });
    const env = h.envs[0];
    expect(env.mountCalls).toBe(1);
    expect(env.mapCalls).toEqual([5173]);
    expect(env.spawnCalls).toEqual([
      {
        command: 'npm run dev -- --host 127.0.0.1',
        opts: {
          cwd: 'client',
          env: {
            APP_MODE: 'development',
            TOKEN: 'secret-value',
            NODE_ENV: 'development',
            NPM_CONFIG_INCLUDE: 'dev',
            PORT: '4500',
          },
          name: 'dev-server:session-1',
        },
      },
    ]);
    expect(h.loadProjectEnv).toHaveBeenCalledWith('project-1', { sessionId: 'session-1' });
    expect(h.fetch).toHaveBeenCalledWith('http://127.0.0.1:4500/healthz');
    expect(h.runtime.getActive('session-1')).toMatchObject({
      id: started.devServerId,
      pid: 7001,
      port: 4500,
      status: 'ready',
    });
    expect(h.runtime.getPorts(started.devServerId)).toEqual([
      {
        name: 'web',
        internalPort: 5173,
        hostPort: 4500,
        primary: true,
        url: '/api/sessions/session-1/preview/proxy/4500',
      },
    ]);
    env.proc?.emitStdout('compiled\nready\n');
    env.proc?.emitStderr('warning\n');
    expect(h.runtime.getLogTail(started.devServerId)).toEqual(['compiled', 'ready', 'warning']);
  });

  it('allocates unique pooled ports and releases the stopped row for reuse', async () => {
    const h = makeHarness({ portRange: { min: 4500, max: 4501 } });
    const project = makeProject();

    const first = await h.runtime.start('session-a', project, '/worktree/a');
    const second = await h.runtime.start('session-b', project, '/worktree/b');
    expect([first.port, second.port]).toEqual([4500, 4501]);
    await expect(h.runtime.start('session-c', project, '/worktree/c')).rejects.toThrow(
      /port pool exhausted/i,
    );

    await h.runtime.stop(first.devServerId);
    const third = await h.runtime.start('session-c', project, '/worktree/c');
    expect(third.port).toBe(4500);
  });

  it('skips a pool port an untracked process still holds', async () => {
    // Regression: a dev server orphaned by a prior session kept listening
    // on 4500 after its DB row was deleted. The pool saw the port as free
    // and handed it to the next session, so the preview proxy tunnelled to
    // the orphan — the pane rendered a different project's app while the
    // session's own boot log showed a healthy start.
    const squatted = new Set([4500]);
    const h = makeHarness({
      portRange: { min: 4500, max: 4502 },
      isPortFree: async (port) => !squatted.has(port),
    });

    const started = await h.runtime.start('session-a', makeProject(), '/worktree/a');

    expect(started.port).toBe(4501);
  });

  it('fails the start when every pool port is held by an untracked process', async () => {
    const h = makeHarness({
      portRange: { min: 4500, max: 4501 },
      isPortFree: async () => false,
    });

    await expect(h.runtime.start('session-a', makeProject(), '/worktree/a')).rejects.toThrow(
      /held by untracked processes/i,
    );
  });

  it('refuses to reserve an extra portMap port that something else is listening on', async () => {
    // A non-primary port cannot be steered via PORT, so the process will
    // bind this exact number. Proxying to whoever already owns it would be
    // the same wrong-app failure as the pooled case.
    const h = makeHarness({
      portRange: { min: 4500, max: 4502 },
      isPortFree: async (port) => port !== 8787,
    });
    const project = makeProject({
      portMap: [
        { internalPort: 5173, label: 'web', primary: true },
        { internalPort: 8787, label: 'api' },
      ],
    });

    await expect(h.runtime.start('session-a', project, '/worktree/a')).rejects.toThrow(
      /8787 \("api"\) is already in use by a process the Hub does not manage/i,
    );
    // The rolled-back start must not strand the group row.
    expect(h.runtime.getActive('session-a')).toBeNull();
  });

  it('escalates to SIGKILL before releasing the port of a restart-orphaned row', async () => {
    // No live SessionEnv (Hub restarted), so the row's pid is signalled
    // directly. Deleting the row while the process survives is exactly how
    // the pool ends up handing out an occupied port.
    const alive = new Set([4242]);
    const signals: Array<[number, NodeJS.Signals | 0]> = [];
    const h = makeHarness({
      kill: (pid, signal) => {
        signals.push([pid, signal]);
        const bare = Math.abs(pid);
        // Only the bare pid is a known process here, so the group form
        // throws first and the runtime falls back — same as a child that
        // was not a group leader.
        if (pid < 0) throw new Error('ESRCH');
        if (!alive.has(bare)) throw new Error('ESRCH');
        // Ignores SIGTERM; only SIGKILL removes it.
        if (signal === 'SIGKILL') alive.delete(bare);
      },
    });
    const started = await h.runtime.start('session-orphan', makeProject(), '/worktree');
    h.db
      .prepare(`UPDATE worktree_preview_processes SET pid = 4242 WHERE group_id = ?`)
      .run(started.devServerId);
    // Drop the in-memory record so stop() takes the restart-orphan path.
    h.runtime.getSessionEnvBySessionId('session-orphan');
    (h.runtime as unknown as { active: Map<string, unknown> }).active.clear();

    await h.runtime.stop(started.devServerId);

    expect(signals.map(([, sig]) => sig)).toContain('SIGTERM');
    expect(signals.map(([, sig]) => sig)).toContain('SIGKILL');
    expect(alive.has(4242)).toBe(false);
    expect(h.runtime.getById(started.devServerId)).toBeNull();
  });

  it('exposes the live session env for the terminal and drops it after stop', async () => {
    const h = makeHarness();
    const started = await h.runtime.start('session-terminal', makeProject(), '/worktree');

    expect(h.runtime.getSessionEnvBySessionId('session-terminal')).toBe(h.envs[0]);
    expect(h.runtime.getSessionEnvBySessionId('missing')).toBeNull();

    await h.runtime.stop(started.devServerId);
    expect(h.runtime.getSessionEnvBySessionId('session-terminal')).toBeNull();
  });

  describe('session-owned environments', () => {
    /** A manager-style env the runtime did not create. */
    function sharedHarness() {
      const shared = new FakeSessionEnv('session-shared', (internalPort) => internalPort);
      const h = makeHarness({ resolveSharedEnv: async () => shared });
      return { h, shared };
    }

    it('runs the preview inside the session env instead of starting a second one', async () => {
      // The preview, the terminal, and anything the agent runs have to share
      // one boundary — otherwise a shell cannot curl the dev server it is
      // looking at, and tests hit a different database than the preview.
      const { h, shared } = sharedHarness();

      await h.runtime.start('session-shared', makeProject(), '/worktree');

      expect(h.envs).toHaveLength(0);
      expect(shared.spawnCalls).toHaveLength(1);
      expect(h.runtime.getSessionEnvBySessionId('session-shared')).toBe(shared);
    });

    it('leaves the session env alive when the preview stops', async () => {
      // Disposing here would take the session's terminal and its Postgres
      // down with the dev server, which is what made stopping a preview feel
      // like ending the session.
      const { h, shared } = sharedHarness();
      const started = await h.runtime.start('session-shared', makeProject(), '/worktree');

      await h.runtime.stop(started.devServerId);

      expect(shared.disposed).toBe(false);
      expect(shared.disposeCalls).toEqual([]);
      // Only the dev server's own process is signalled.
      expect(shared.proc?.killCalls).toEqual(['SIGTERM']);
    });

    it('reports the container address as the proxy upstream host', async () => {
      // Loopback is only right when the env publishes ports onto the host.
      // A container env answers on its own bridge address, and dialing
      // loopback there reaches nothing — or an unrelated process holding
      // that port, which is how a preview ends up serving another app.
      const shared = new FakeSessionEnv('session-shared', (p) => p);
      shared.kind = 'container';
      shared.dialHost = '172.17.0.9';
      const h = makeHarness({ resolveSharedEnv: async () => shared });

      await h.runtime.start('session-shared', makeProject(), '/worktree');
      await flushMicrotasks();

      expect(h.runtime.getSessionUpstreamHost('session-shared')).toBe('172.17.0.9');
    });

    it('follows the env mapping when the session env did not honor the reservation', async () => {
      // The production shape of this: `SessionEnvManager` creates the session's
      // env without the preview's pooled allocator, so a publishing adapter
      // falls back to mapping each port to itself. The reservation said 4500 and
      // the app is reachable on 4200 — and the row is what the readiness probe,
      // the proxy, and the client URL all read, so leaving it at 4500 means
      // every preview on this path times out against a dead port.
      const shared = new FakeSessionEnv('session-shared', (internalPort) => internalPort);
      const h = makeHarness({ resolveSharedEnv: async () => shared });

      const started = await h.runtime.start(
        'session-shared',
        makeProject({ portMap: [{ internalPort: 4200, label: 'Frontend', primary: true }] }),
        '/worktree',
      );
      await flushMicrotasks();

      expect(started.port).toBe(4200);
      const row = h.db.prepare(`SELECT port, url FROM worktree_preview_processes`).get() as {
        port: number;
        url: string;
      };
      expect(row.port).toBe(4200);
      expect(row.url).toContain('/preview/proxy/4200');
      // The probe followed the same number, rather than the reserved 4500.
      const probed = h.fetch.mock.calls.map((c) => String(c[0])).join(' ');
      expect(probed).toContain(':4200');
      expect(probed).not.toContain(':4500');
    });

    it('reports no override for a session with no live env', () => {
      const h = makeHarness();
      expect(h.runtime.getSessionUpstreamHost('never-started')).toBeNull();
    });

    it('reports no override when the env publishes onto the host', async () => {
      // A loopback mapping means "reach me on the host", and the Hub's own
      // loopback is not necessarily the way there — a Hub inside a container
      // has to go via the docker-host gateway. Returning the literal
      // 127.0.0.1 would override that gateway and break the proxy.
      const shared = new FakeSessionEnv('session-shared', (p) => p);
      shared.dialHost = '127.0.0.1';
      const h = makeHarness({ resolveSharedEnv: async () => shared });

      await h.runtime.start('session-shared', makeProject(), '/worktree');
      await flushMicrotasks();

      expect(h.runtime.getSessionUpstreamHost('session-shared')).toBeNull();
    });
  });

  describe('container-IP routing', () => {
    /** An env that answers on its own address and publishes nothing. */
    function containerEnv(sessionId: string, ip = '172.17.0.9'): FakeSessionEnv {
      const env = new FakeSessionEnv(sessionId, (internalPort) => internalPort);
      env.kind = 'container';
      env.portRouting = 'container-ip';
      env.dialHost = ip;
      return env;
    }

    /** Survey Tracker's real shape: an Angular dev server on 4200. */
    const project = () =>
      makeProject({ portMap: [{ internalPort: 4200, label: 'Frontend', primary: true }] });

    it('reserves the port the process actually binds, not one from the host pool', async () => {
      // The bug this pins: the row kept a pooled host port (4500) while the
      // process bound 4200 inside the container, so both the proxy and the
      // readiness probe dialed a number nothing was listening on and the
      // preview failed after the full timeout.
      const shared = containerEnv('session-c');
      const h = makeHarness({ resolveSharedEnv: async () => shared });

      await h.runtime.start('session-c', project(), '/worktree');

      const row = h.db
        .prepare(`SELECT port, internal_port, dial_scope FROM worktree_preview_processes`)
        .get() as { port: number; internal_port: number; dial_scope: string };
      expect(row).toEqual({ port: 4200, internal_port: 4200, dial_scope: 'env' });
    });

    it('tells the dev server which Host the proxy will send', async () => {
      // Otherwise a Vite-based dev server allowlists only the static default
      // and answers the proxied iframe request — and the HMR upgrade — with its
      // blocked-host 403, while the readiness probe (Host: localhost) passes.
      const shared = containerEnv('session-c', '172.17.0.9');
      const h = makeHarness({ resolveSharedEnv: async () => shared });

      await h.runtime.start('session-c', project(), '/worktree');

      expect(shared.spawnCalls[0].opts.env).toMatchObject({
        AGENT_HUB_PREVIEW_HEALTH_HOST: '172.17.0.9',
      });
    });

    it('probes the container address, not the Hub-wide health host', async () => {
      // healthUrlBase exists to translate loopback for a Hub inside Docker.
      // Applying it to a container-routed env probes the docker-host gateway
      // for a port nothing published.
      const shared = containerEnv('session-c');
      const h = makeHarness({
        resolveSharedEnv: async () => shared,
        healthUrlBase: (port) => `http://host.docker.internal:${port}`,
      });

      await h.runtime.start('session-c', project(), '/worktree');
      await flushMicrotasks();

      expect(h.fetch).toHaveBeenCalledWith('http://172.17.0.9:4200/');
    });

    it('does not draw from the host port pool', async () => {
      // Two sessions serving 4200 is normal once ports are namespaced per
      // container. A pool of exactly one port proves nothing was taken from
      // it: under the old model the second start would have exhausted it.
      const first = containerEnv('session-a', '172.17.0.4');
      const second = containerEnv('session-b', '172.17.0.5');
      const envs = new Map([
        ['session-a', first],
        ['session-b', second],
      ]);
      const h = makeHarness({
        portRange: { min: 4500, max: 4500 },
        resolveSharedEnv: async (sessionId) => envs.get(sessionId) ?? null,
      });

      await h.runtime.start('session-a', project(), '/worktree');
      await h.runtime.start('session-b', project(), '/worktree');

      const ports = h.db
        .prepare(`SELECT port, dial_scope FROM worktree_preview_processes ORDER BY rowid`)
        .all() as Array<{ port: number; dial_scope: string }>;
      expect(ports).toEqual([
        { port: 4200, dial_scope: 'env' },
        { port: 4200, dial_scope: 'env' },
      ]);
    });

    it('still disposes an env it created itself', async () => {
      const h = makeHarness();
      const started = await h.runtime.start('session-owned', makeProject(), '/worktree');

      await h.runtime.stop(started.devServerId);

      expect(h.envs[0].disposed).toBe(true);
    });
  });

  it('injects the adapter-facing env port while persisting the host proxy port', async () => {
    const h = makeHarness({ resolveEnvPort: (internalPort) => internalPort });
    const project = makeProject({
      portMap: [{ internalPort: 5173, label: 'web', primary: true }],
    });

    const started = await h.runtime.start('session-translated', project, '/worktree');

    expect(started.port).toBe(4500);
    expect(h.envs[0].spawnCalls[0].opts.env).toMatchObject({ PORT: '5173' });
    expect(h.runtime.getPorts(started.devServerId)[0]).toMatchObject({
      internalPort: 5173,
      hostPort: 4500,
    });
  });

  it('maps every port primary-first and resolves per-entry proxy URLs', async () => {
    const h = makeHarness({
      portRange: { min: 4500, max: 4502 },
      // Prod-mode resolver: primary → mount, extra → /p/<internalPort>.
      portClientUrl: ({ sessionId, hostPort, internalPort, primary }) =>
        resolveDevServerPortClientUrl(
          'https://hub.example.com',
          sessionId,
          hostPort,
          internalPort,
          primary,
        ),
    });
    const project = makeProject({
      portMap: [
        { internalPort: 5173, label: 'web', primary: true },
        { internalPort: 8787, label: 'api' },
      ],
    });

    const started = await h.runtime.start('session-multi', project, '/worktree');
    await flushMicrotasks();

    // Primary allocates from the pool; extras bind their internal port.
    expect(started.port).toBe(4500);
    expect(started.url).toBe('/api/sessions/session-multi/preview/proxy');
    // mapPortsOut resolves primary first, then extras.
    expect(h.envs[0].mapCalls).toEqual([5173, 8787]);
    expect(h.runtime.getPorts(started.devServerId)).toEqual([
      {
        name: 'web',
        internalPort: 5173,
        hostPort: 4500,
        primary: true,
        url: '/api/sessions/session-multi/preview/proxy',
      },
      {
        name: 'api',
        internalPort: 8787,
        hostPort: 8787,
        primary: false,
        url: '/api/sessions/session-multi/preview/proxy/p/8787',
      },
    ]);
  });

  it('exposes client-facing ports and emits them on the ready notifyStatus (multi-port)', async () => {
    const notifyStatus = vi.fn();
    const h = makeHarness({
      portRange: { min: 4500, max: 4502 },
      notifyStatus,
      portClientUrl: ({ sessionId, hostPort, internalPort, primary }) =>
        resolveDevServerPortClientUrl(
          'https://hub.example.com',
          sessionId,
          hostPort,
          internalPort,
          primary,
        ),
    });
    const project = makeProject({
      portMap: [
        { internalPort: 5173, label: 'web', primary: true },
        { internalPort: 8787, label: 'api' },
      ],
    });

    const started = await h.runtime.start('session-ports', project, '/worktree');
    await flushMicrotasks();

    const expectedPorts = [
      {
        internalPort: 5173,
        label: 'web',
        primary: true,
        url: '/api/sessions/session-ports/preview/proxy',
      },
      {
        internalPort: 8787,
        label: 'api',
        primary: false,
        url: '/api/sessions/session-ports/preview/proxy/p/8787',
      },
    ];
    expect(h.runtime.getClientPorts(started.devServerId)).toEqual(expectedPorts);
    // The ready broadcast carries the port list so the pane can render its
    // selector; the label comes from the (uniquified) portMap label.
    expect(notifyStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'ready', ports: expectedPorts }),
    );
  });

  it('resolves upstream host ports by internal port once ready', async () => {
    const h = makeHarness({ portRange: { min: 4500, max: 4502 } });
    const project = makeProject({
      portMap: [
        { internalPort: 5173, label: 'web', primary: true },
        { internalPort: 8787, label: 'api' },
      ],
    });

    const started = await h.runtime.start('session-up', project, '/worktree');
    await flushMicrotasks();
    expect(h.runtime.getActive('session-up')?.status).toBe('ready');

    // Primary (no internal port) → pooled host port; extra → its mapped port.
    expect(h.runtime.getSessionUpstreamPort('session-up')).toBe(4500);
    expect(h.runtime.getSessionUpstreamPort('session-up', 5173)).toBe(4500);
    expect(h.runtime.getSessionUpstreamPort('session-up', 8787)).toBe(8787);
    // Unknown internal port / session → null (proxy returns 503).
    expect(h.runtime.getSessionUpstreamPort('session-up', 9999)).toBeNull();
    expect(h.runtime.getSessionUpstreamPort('missing', 5173)).toBeNull();

    await h.runtime.stop(started.devServerId);
    expect(h.runtime.getSessionUpstreamPort('session-up')).toBeNull();
  });

  it('does not resolve an upstream port while the group is not ready', async () => {
    // Health probe never succeeds → the group stays `starting`, so the proxy
    // upstream lookup must return null (proxy answers 503) rather than route
    // to a port that is not serving yet.
    const h = makeHarness({
      fetchOk: false,
      readyTimeoutMs: 1,
      portRange: { min: 4500, max: 4501 },
    });
    await h.runtime.start('session-starting', makeProject(), '/worktree');
    expect(h.runtime.getActive('session-starting')?.status).not.toBe('ready');
    expect(h.runtime.getSessionUpstreamPort('session-starting')).toBeNull();
  });

  it('rolls back rows and disposes the env when spawn throws', async () => {
    const h = makeHarness({
      envSetup: (env) => {
        env.throwOnSpawn = new Error('spawn exploded');
      },
    });

    await expect(h.runtime.start('session-fail', makeProject(), '/worktree')).rejects.toThrow(
      'spawn exploded',
    );
    expect(h.envs[0].disposed).toBe(true);
    const groups = h.db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_groups`).get() as {
      n: number;
    };
    expect(groups.n).toBe(0);
  });

  it('disposes the env (no orphaned sysbox container) when a system-dep apt install fails', async () => {
    const h = makeHarness({
      envSetup: (env) => {
        env.kind = 'sysbox';
        // The apt spawn is the FIRST spawn; make it exit non-zero.
        env.preExitNextSpawn = { code: 100, signal: null };
      },
    });

    await expect(
      h.runtime.start('session-apt-fail', makeProject({ aptPackages: ['badpkg'] }), '/worktree'),
    ).rejects.toThrow(/system dependency install failed/);

    // Env torn down via rollbackStart — the container acquired earlier in
    // start() must not survive a pre-`proc` failure.
    expect(h.envs[0].disposed).toBe(true);
    // apt was the only spawn; the app start command never ran.
    expect(h.envs[0].spawnCalls).toHaveLength(1);
    expect(h.envs[0].spawnCalls[0].command).toContain('apt-get');
    const groups = h.db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_groups`).get() as {
      n: number;
    };
    expect(groups.n).toBe(0);
  });

  it('releases reserved rows when SessionEnv construction fails', async () => {
    const h = makeHarness({ createEnvError: new Error('adapter unavailable') });

    await expect(h.runtime.start('session-no-env', makeProject(), '/worktree')).rejects.toThrow(
      'adapter unavailable',
    );
    const groups = h.db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_groups`).get() as {
      n: number;
    };
    const processes = h.db
      .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes`)
      .get() as { n: number };
    expect({ groups: groups.n, processes: processes.n }).toEqual({ groups: 0, processes: 0 });
  });

  it('marks a health timeout failed and disposes the whole env/process tree', async () => {
    const h = makeHarness({ fetchOk: false });
    const started = await h.runtime.start('session-timeout', makeProject(), '/worktree');
    await flushMicrotasks(30);

    expect(h.runtime.getById(started.devServerId)?.status).toBe('failed');
    expect(h.envs[0].disposeCalls).toEqual([{ graceMs: 25 }]);
    expect(h.envs[0].proc?.killCalls).toEqual(['SIGTERM']);
  });

  it('stop and restart dispose the prior process group and leave one active row', async () => {
    const h = makeHarness();
    const project = makeProject();
    const first = await h.runtime.start('session-restart', project, '/worktree');
    const second = await h.runtime.restart('session-restart', project, '/worktree');

    expect(second.devServerId).not.toBe(first.devServerId);
    expect(h.envs[0].disposeCalls).toEqual([{ graceMs: 25 }]);
    expect(h.envs[0].proc?.killCalls).toEqual(['SIGTERM']);
    const rows = h.db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE session_id = ?`)
      .all('session-restart') as Array<{ id: string }>;
    expect(rows).toEqual([{ id: second.devServerId }]);

    expect(await h.runtime.stopBySessionId('session-restart')).toBe(1);
    expect(h.runtime.getActive('session-restart')).toBeNull();
    expect(h.envs[1].disposeCalls).toEqual([{ graceMs: 25 }]);
  });

  it('reaps idle and deleted-project rows through the same teardown path', async () => {
    const project = makeProject({}, { idleTTL: 1 });
    const projects = new Map<string, Project>([[project.id, project]]);
    const h = makeHarness({ getProject: (id) => projects.get(id) ?? null });
    const idle = await h.runtime.start('session-idle', project, '/worktree/idle');
    const orphan = await h.runtime.start('session-orphan', project, '/worktree/orphan');
    h.db
      .prepare(`UPDATE worktree_preview_groups SET last_active_at = datetime('now', '-10 seconds')`)
      .run();
    projects.clear();

    const result = await h.runtime.reap(Date.now());

    expect(result).toMatchObject({ scanned: 2, reaped: 0, orphaned: 2 });
    expect(result.notes).toEqual([
      expect.stringContaining(idle.devServerId),
      expect.stringContaining(orphan.devServerId),
    ]);
    expect(h.envs.every((env) => env.disposed)).toBe(true);
  });
});

describe('DevServerRuntime log streaming + tail buffer', () => {
  it('fans every stdout/stderr line out via notifyLog with the stream tag', async () => {
    const notifyLog = vi.fn();
    const h = makeHarness({ notifyLog });
    const project = makeProject({
      portMap: [{ internalPort: 5173, label: 'web', primary: true }],
    });
    const started = await h.runtime.start('session-logs', project, '/worktree');
    await flushMicrotasks();

    h.envs[0].proc?.emitStdout('vite ready\nhmr update\n');
    h.envs[0].proc?.emitStderr('deprecation warning\n');

    const base = { sessionId: 'session-logs', groupId: started.devServerId, processName: 'web' };
    expect(notifyLog.mock.calls.map(([info]) => info)).toEqual([
      { ...base, line: 'vite ready', stream: 'stdout' },
      { ...base, line: 'hmr update', stream: 'stdout' },
      { ...base, line: 'deprecation warning', stream: 'stderr' },
    ]);
  });

  it('a throwing notifyLog never breaks the tail append', async () => {
    const notifyLog = vi.fn(() => {
      throw new Error('ws send failed');
    });
    const h = makeHarness({ notifyLog });
    const started = await h.runtime.start('session-throw', makeProject(), '/worktree');
    await flushMicrotasks();

    h.envs[0].proc?.emitStdout('line-1\nline-2\n');
    expect(h.runtime.getLogTail(started.devServerId)).toEqual(['line-1', 'line-2']);
  });

  it('bounds the ring buffer to logTailLines, dropping the oldest lines first', async () => {
    const h = makeHarness({ logTailLines: 3 });
    const started = await h.runtime.start('session-ring', makeProject(), '/worktree');
    await flushMicrotasks();

    h.envs[0].proc?.emitStdout('a\nb\nc\nd\n');
    h.envs[0].proc?.emitStderr('e\n');
    expect(h.runtime.getLogTail(started.devServerId)).toEqual(['c', 'd', 'e']);
  });

  it('getLogTail returns a copy and [] for unknown groups', async () => {
    const h = makeHarness();
    const started = await h.runtime.start('session-copy', makeProject(), '/worktree');
    await flushMicrotasks();

    h.envs[0].proc?.emitStdout('original\n');
    const tail = h.runtime.getLogTail(started.devServerId);
    tail.push('mutated');
    expect(h.runtime.getLogTail(started.devServerId)).toEqual(['original']);
    expect(h.runtime.getLogTail('no-such-group')).toEqual([]);
  });
});

describe('DevServerRuntime two-phase readiness', () => {
  it('rebases the readiness deadline once the port binds within the boot budget', async () => {
    const clock = new FakeClock();
    // Bind (first non-throwing probe) at t=8, inside the original 10ms
    // window; first 2xx at t=15 — past the original deadline but inside
    // the rebased one (8 + 10 = 18). Without the rebase this boot fails.
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      if (clock.now < 8) throw new Error('ECONNREFUSED');
      if (clock.now < 15) return { ok: false, status: 503 };
      return { ok: true, status: 200 };
    };
    const notifyStatus = vi.fn();
    const h = makeHarness({ clock, fetchImpl, readyTimeoutMs: 10, notifyStatus });

    const started = await h.runtime.start('session-rebase', makeProject(), '/worktree');
    await flushMicrotasks(120);

    expect(h.runtime.getById(started.devServerId)?.status).toBe('ready');
    expect(notifyStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
  });

  it('fails with a bind-phase reason when the port never binds', async () => {
    const clock = new FakeClock();
    const notifyStatus = vi.fn();
    const h = makeHarness({
      clock,
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
      readyTimeoutMs: 5,
      notifyStatus,
    });

    const started = await h.runtime.start('session-never-bound', makeProject(), '/worktree');
    await flushMicrotasks(80);

    expect(h.runtime.getById(started.devServerId)?.status).toBe('failed');
    expect(notifyStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('port never bound'),
      }),
    );
  });

  it('a bind that overran the boot budget earns no fresh readiness window', async () => {
    const clock = new FakeClock();
    // The single probe response lands at t=6, past the 5ms budget: the
    // rebase gate must leave the original deadline in place so the next
    // expiry check fails the boot instead of extending it.
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      clock.now += 6;
      return { ok: false, status: 503 };
    };
    const notifyStatus = vi.fn();
    const h = makeHarness({ clock, fetchImpl, readyTimeoutMs: 5, notifyStatus });

    const started = await h.runtime.start('session-overrun', makeProject(), '/worktree');
    await flushMicrotasks(40);

    expect(h.runtime.getById(started.devServerId)?.status).toBe('failed');
    expect(notifyStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'failed',
        // The reason must name the window that was actually granted —
        // none — not the full readyTimeoutMs a rebase would have given.
        error: expect.stringContaining('port bound at +6ms, after the 5ms boot budget expired'),
      }),
    );
  });

  it('the per-project readyTimeoutMs override drives the phase budget', async () => {
    const clock = new FakeClock();
    // Runtime default budget is 5ms; the project override (Zod floor is
    // 5s) is effectively unbounded on this fake clock. Bind at t=8 —
    // dead under the runtime default, alive under the project override.
    const fetchImpl = async (): Promise<{ ok: boolean; status: number }> => {
      if (clock.now < 8) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200 };
    };
    const h = makeHarness({ clock, fetchImpl, readyTimeoutMs: 5 });
    const project = makeProject({ readyTimeoutMs: 20_000 });
    const started = await h.runtime.start('session-project-budget', project, '/worktree');
    await flushMicrotasks(60);

    expect(h.runtime.getById(started.devServerId)?.status).toBe('ready');
  });
});

describe('DevServerRuntime react/snapshot surface', () => {
  it('listActive returns only dev-server groups, with primary port + url', async () => {
    const h = makeHarness();
    const a = await h.runtime.start('session-a', makeProject(), '/worktree/a');
    const b = await h.runtime.start('session-b', makeProject(), '/worktree/b');
    await flushMicrotasks();
    // A foreign row (compose/legacy — no dev-server runtime marker) must
    // be invisible to this runtime's snapshot listing.
    h.db
      .prepare(
        `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
         VALUES ('foreign-group', 'session-compose', 'project-1', 'starting')`,
      )
      .run();
    // A dev-server group with no primary process row has no port/url a
    // snapshot could render — it must be filtered, not emitted as
    // port 0 / empty url.
    h.db
      .prepare(
        `INSERT INTO worktree_preview_groups (id, session_id, project_id, status, runtime)
         VALUES ('primaryless-group', 'session-primaryless', 'project-1', 'starting', 'dev-server')`,
      )
      .run();

    const rows = h.runtime.listActive();
    expect(rows.map((r) => r.id).sort()).toEqual([a.devServerId, b.devServerId].sort());
    const rowA = rows.find((r) => r.id === a.devServerId);
    expect(rowA).toMatchObject({
      session_id: 'session-a',
      status: 'ready',
      port: a.port,
      url: a.url,
    });
  });

  it('touchPreview bumps last_active_at like touch', async () => {
    const h = makeHarness();
    const started = await h.runtime.start('session-touch', makeProject(), '/worktree');
    await flushMicrotasks();
    h.db.prepare(`UPDATE worktree_preview_groups SET last_active_at = '2020-01-01 00:00:00'`).run();

    h.runtime.touchPreview(started.devServerId);

    const row = h.db
      .prepare(`SELECT last_active_at FROM worktree_preview_groups WHERE id = ?`)
      .get(started.devServerId) as { last_active_at: string };
    expect(row.last_active_at).not.toBe('2020-01-01 00:00:00');
  });

  it('serverReachableUrlForPort mirrors the health-probe base', () => {
    const h = makeHarness();
    expect(h.runtime.serverReachableUrlForPort(4500)).toBe('http://127.0.0.1:4500');
  });
});
