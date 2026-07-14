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
  SessionEnvPortMapping,
  SessionEnvProcess,
  SessionEnvPty,
  SessionEnvPtyOpts,
  SessionEnvSpawnOpts,
  SessionEnvWorktreeMount,
} from '../session-env/session-env.js';
import type { Clock } from './preview-runtime.js';
import {
  buildDevServerSpawnEnv,
  DevServerRuntime,
  resolveDevServerPortEntries,
  uniquePortEntryNames,
  type CreateDevServerEnvFn,
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
  readonly kind = 'host' as const;
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
    this.proc = new FakeProcess(7000 + this.spawnCalls.length, opts.name ?? command);
    return this.proc;
  }

  openPty(_opts?: SessionEnvPtyOpts): Promise<SessionEnvPty> {
    throw new Error('not used by DevServerRuntime');
  }

  async mapPort(internalPort: number): Promise<SessionEnvPortMapping> {
    this.mapCalls.push(internalPort);
    const existing = this.mappings.get(internalPort);
    if (existing) return existing;
    const hostPort = this.allocateHostPort(internalPort);
    const mapping = {
      internalPort,
      hostPort,
      envPort: this.resolveEnvPort(internalPort, hostPort),
      hostUrl: `http://127.0.0.1:${hostPort}`,
    };
    this.mappings.set(internalPort, mapping);
    return mapping;
  }

  listPortMappings(): SessionEnvPortMapping[] {
    return [...this.mappings.values()];
  }

  async mountWorktree(): Promise<SessionEnvWorktreeMount> {
    this.mountCalls++;
    return { hostPath: '/worktree', envPath: '/worktree' };
  }

  liveProcessCount(): number {
    return this.proc && !this.proc.exited ? 1 : 0;
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
    envSetup?: (env: FakeSessionEnv) => void;
    createEnvError?: Error;
    resolveEnvPort?: (internalPort: number, hostPort: number) => number;
    getProject?: (projectId: string) => Project | null;
    portRange?: { min: number; max: number };
  } = {},
): Harness {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const clock = new FakeClock();
  const envs: FakeSessionEnv[] = [];
  const createEnv: CreateDevServerEnvFn = ({ sessionId, allocateHostPort }) => {
    if (opts.createEnvError) throw opts.createEnvError;
    const env = new FakeSessionEnv(sessionId, allocateHostPort, opts.resolveEnvPort);
    opts.envSetup?.(env);
    envs.push(env);
    return env;
  };
  const fetch = vi.fn().mockResolvedValue({ ok: opts.fetchOk ?? true, status: 200 });
  const loadProjectEnv = vi
    .fn()
    .mockReturnValue({ TOKEN: 'secret-value', UNUSED: 'do-not-inject' });
  const runtime = new DevServerRuntime({
    db,
    createEnv,
    fetch,
    clock,
    loadProjectEnv,
    getProject: opts.getProject,
    config: {
      portRange: opts.portRange ?? { min: 4500, max: 4502 },
      readyTimeoutMs: 2,
      healthIntervalMs: 1,
      disposeGraceMs: 25,
      urlBase: (port, sessionId) => `/api/sessions/${sessionId}/preview/proxy/${port}`,
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
      },
      projectSecrets: { TOKEN: 'shh', UNUSED: 'not-selected' },
      envPort: 4510,
    });

    expect(result).toEqual({
      env: { APP_MODE: 'development', TOKEN: 'shh', PORT: '4510' },
      missingSecretKeys: ['MISSING'],
    });
  });

  it('normalizes a primary port and disambiguates duplicate labels', () => {
    const entries = resolveDevServerPortEntries({
      startCommand: 'npm run dev',
      env: {},
      secretKeys: [],
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
          env: { APP_MODE: 'development', TOKEN: 'secret-value', PORT: '4500' },
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
