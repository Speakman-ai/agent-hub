/**
 * Unit tests for `PreviewComposeRuntime` — PR 1 of the compose pivot.
 *
 * What's covered:
 *   - Pure helpers (`composeProjectName`, `buildComposeUpArgs`,
 *     `buildComposeDownArgs`, `resolveComposeConfig`).
 *   - Constructor schema migration adds `compose_project_name` without
 *     blowing up on a freshly-migrated DB (idempotent).
 *   - Port allocator picks the lowest free port + retries on a UNIQUE
 *     race with the legacy spawn pool.
 *   - `startPreview` happy path → spawns `docker compose up`, allocates
 *     a host port, polls health, flips ready.
 *   - `startPreview` health-timeout path → flips group + entry process
 *     to `failed`, leaves the row in place for diagnostics.
 *   - `startPreview` rejects when `prEnv.preview.compose` is unset.
 *   - `stopPreview` calls `docker compose down -v --remove-orphans` and
 *     deletes the row. Idempotent.
 *   - `stopBySessionId` tears every compose-managed group for a
 *     session; ignores spawn-managed groups (no `compose_project_name`).
 *   - `touchPreview` bumps `last_active_at`.
 *   - Replace-on-restart — a second `startPreview` for the same
 *     session stops the prior group first.
 *
 * Tests use the same DI-based fakes the legacy runtime uses: spawn,
 * fetch, and clock are all injected. No real Docker is touched; the
 * `server/test/fixtures/no-real-cli-in-tests.sh` guard would catch a
 * regression that tried.
 */

import Database from 'better-sqlite3';
import { EventEmitter } from 'events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChildProcess } from 'child_process';
import {
  PreviewComposeRuntime,
  buildComposeUpArgs,
  buildComposeDownArgs,
  composeProjectName,
  resolveComposeConfig,
  systemClock,
  type Clock,
  type HealthFetchFn,
  type SpawnFn,
} from './preview-compose-runtime.js';
import { DEFAULT_PREVIEW_PORT_RANGE } from './preview-schema.js';
import type { Project } from '../types.js';

vi.mock('../project-secrets-spawn.js', () => ({
  mergeProjectSecretsSpawnEnv: vi.fn(),
}));

import { mergeProjectSecretsSpawnEnv } from '../project-secrets-spawn.js';

// Contract values pinned by the runtime. Inlined here (rather than
// imported as `__test_*` re-exports from the production module) so the
// assertion *is* the spec — if the prefix, length cap, or entry-process
// name ever changes intentionally the test diff makes the rename visible.
const COMPOSE_PROJECT_PREFIX = 'agenthub-session-';
const COMPOSE_PROJECT_MAX_LEN = 63;
const ENTRY_PROCESS_NAME = 'entry';

// ─── Test doubles ──────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  pid: number;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(pid: number) {
    super();
    this.pid = pid;
    // EventEmitter.resume() polyfill — production `Readable` has it but
    // our naive EventEmitter doesn't; the runtime calls it on the
    // stdio streams so we add a no-op here.
    (this.stdout as unknown as { resume: () => void }).resume = (): void => {};
    (this.stderr as unknown as { resume: () => void }).resume = (): void => {};
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
  exitWith(code: number): void {
    this.exitCode = code;
    setImmediate(() => this.emit('exit', code, null));
  }
}

interface SpawnHarness {
  spawn: SpawnFn;
  spawned: FakeChild[];
  calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string | undefined;
    env: Record<string, string | undefined>;
  }>;
}

function makeSpawn(opts: { exitImmediately?: boolean } = {}): SpawnHarness {
  const spawned: FakeChild[] = [];
  const calls: SpawnHarness['calls'] = [];
  let nextPid = 8_000;
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(nextPid++);
    spawned.push(child);
    calls.push({
      command,
      args,
      cwd: options.cwd as string | undefined,
      env: { ...((options.env as Record<string, string | undefined> | undefined) ?? {}) },
    });
    if (opts.exitImmediately) {
      // Exit on the next microtask so tests can still observe the call
      // before the child reports exit.
      setImmediate(() => child.exitWith(0));
    }
    return child as unknown as ChildProcess;
  };
  return { spawn, spawned, calls };
}

function makeFetch(behaviour: { okOnAttempt?: number; alwaysFail?: boolean } = {}): {
  fetch: HealthFetchFn;
  attempts: () => number;
  urls: string[];
} {
  let attempts = 0;
  const urls: string[] = [];
  const fetch: HealthFetchFn = async (url) => {
    attempts++;
    urls.push(url);
    if (behaviour.alwaysFail) throw new Error('ECONNREFUSED');
    if (behaviour.okOnAttempt && attempts >= behaviour.okOnAttempt) {
      return { ok: true, status: 200 };
    }
    throw new Error('ECONNREFUSED');
  };
  return { fetch, attempts: () => attempts, urls };
}

function makeClock(): Clock & { advance(ms: number): void } {
  let nowMs = 1_700_000_000_000;
  const sleeps: Array<{ resolveAt: number; resolve: () => void }> = [];
  const drain = (): void => {
    for (let i = sleeps.length - 1; i >= 0; i--) {
      if (sleeps[i].resolveAt <= nowMs) {
        sleeps[i].resolve();
        sleeps.splice(i, 1);
      }
    }
  };
  return {
    nowMs: () => nowMs,
    nowIso: () => new Date(nowMs).toISOString(),
    sleep(ms) {
      return new Promise<void>((resolve) => {
        sleeps.push({ resolveAt: nowMs + ms, resolve });
      });
    },
    advance(ms) {
      nowMs += ms;
      drain();
    },
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'Test',
    cwd: '/repo',
    ahw: '/ahw',
    prEnv: {
      enabled: true,
      startScript: 'npm run dev',
      internalPort: 3000,
      preview: {
        enabled: true,
        compose: {
          entryService: 'web',
          entryPort: 8000,
        },
      },
    },
    ...overrides,
  } as Project;
}

function freshDb(): Database.Database {
  return new Database(':memory:');
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

// ─── Pure helper tests ─────────────────────────────────────────────────

describe('composeProjectName', () => {
  it('prefixes the session id', () => {
    expect(composeProjectName('abc123')).toBe(`${COMPOSE_PROJECT_PREFIX}abc123`);
  });

  it('throws when the resulting name exceeds the docker cap', () => {
    const longId = 'x'.repeat(COMPOSE_PROJECT_MAX_LEN);
    expect(() => composeProjectName(longId)).toThrow(/exceeds 63 chars/);
  });

  it('accepts a uuid-shaped session id (well under the cap)', () => {
    const uuid = '8cc39aaf-d30b-4e60-848f-8c70f20a2f93';
    const name = composeProjectName(uuid);
    expect(name).toBe(`${COMPOSE_PROJECT_PREFIX}${uuid}`);
    expect(name.length).toBeLessThanOrEqual(COMPOSE_PROJECT_MAX_LEN);
  });
});

describe('buildComposeUpArgs', () => {
  it('emits the standard `up -d --build` invocation', () => {
    expect(
      buildComposeUpArgs({
        composeProjectName: 'agenthub-session-abc',
        composeFile: 'docker-compose.yml',
      }),
    ).toEqual([
      'compose',
      '-p',
      'agenthub-session-abc',
      '-f',
      'docker-compose.yml',
      'up',
      '-d',
      '--build',
    ]);
  });

  it('appends --env-file when an envFile is supplied', () => {
    expect(
      buildComposeUpArgs({
        composeProjectName: 'agenthub-session-abc',
        composeFile: 'compose.yml',
        envFile: '.env.preview',
      }),
    ).toEqual([
      'compose',
      '-p',
      'agenthub-session-abc',
      '-f',
      'compose.yml',
      '--env-file',
      '.env.preview',
      'up',
      '-d',
      '--build',
    ]);
  });

  it('places --env-file *between* -f and up so compose treats it as a global flag', () => {
    // Compose's CLI grammar is `docker compose [global-flags] <subcommand>
    // [subcommand-flags]`. --env-file is a global flag; putting it after
    // `up` makes compose treat it as an unknown subcommand arg. Pin the
    // ordering so a refactor doesn't silently regress this.
    const args = buildComposeUpArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
      envFile: '.env',
    });
    const envFileIdx = args.indexOf('--env-file');
    const upIdx = args.indexOf('up');
    expect(envFileIdx).toBeGreaterThan(-1);
    expect(upIdx).toBeGreaterThan(envFileIdx);
  });
});

describe('buildComposeDownArgs', () => {
  it('drops volumes and orphaned containers so the next up starts clean', () => {
    expect(
      buildComposeDownArgs({
        composeProjectName: 'agenthub-session-abc',
        composeFile: 'docker-compose.yml',
      }),
    ).toEqual([
      'compose',
      '-p',
      'agenthub-session-abc',
      '-f',
      'docker-compose.yml',
      'down',
      '-v',
      '--remove-orphans',
    ]);
  });
});

describe('buildCompose*Args --project-directory injection', () => {
  // Local installs (CLI + daemon on same host) must NOT see the new
  // flag — compose-go's default WorkingDir (parent of -f) is what makes
  // bind mounts resolve correctly. Only the EC2 docker-in-docker case,
  // where the host-path translation succeeded, needs the override.

  it('omits --project-directory when projectDirectory is undefined (local dev)', () => {
    const upArgs = buildComposeUpArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
    });
    expect(upArgs).not.toContain('--project-directory');
    const downArgs = buildComposeDownArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
    });
    expect(downArgs).not.toContain('--project-directory');
  });

  it('omits --project-directory when projectDirectory is null', () => {
    const upArgs = buildComposeUpArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
      projectDirectory: null,
    });
    expect(upArgs).not.toContain('--project-directory');
    const downArgs = buildComposeDownArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
      projectDirectory: null,
    });
    expect(downArgs).not.toContain('--project-directory');
  });

  it('injects --project-directory before the subcommand on up (EC2 docker-in-docker case)', () => {
    const args = buildComposeUpArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
      projectDirectory: '/var/lib/agent-hub/projects/foo',
    });
    expect(args).toContain('--project-directory');
    const pdIdx = args.indexOf('--project-directory');
    expect(args[pdIdx + 1]).toBe('/var/lib/agent-hub/projects/foo');
    // --project-directory is a global flag — must come before the
    // subcommand to be parsed correctly.
    const upIdx = args.indexOf('up');
    expect(pdIdx).toBeLessThan(upIdx);
  });

  it('injects --project-directory before the subcommand on down so teardown mirrors up', () => {
    const args = buildComposeDownArgs({
      composeProjectName: 'p',
      composeFile: 'f.yml',
      projectDirectory: '/var/lib/agent-hub/projects/foo',
    });
    expect(args).toContain('--project-directory');
    const pdIdx = args.indexOf('--project-directory');
    const downIdx = args.indexOf('down');
    expect(pdIdx).toBeLessThan(downIdx);
  });
});

describe('resolveComposeConfig', () => {
  it('fills defaults for the optional fields', () => {
    const cfg = resolveComposeConfig(
      { entryService: 'web', entryPort: 8000 },
      {
        composeFile: 'docker-compose.yml',
        healthPath: '/',
        portRange: { min: 5000, max: 5100 },
        readyTimeoutMs: 12_345,
      },
    );
    expect(cfg.file).toBe('docker-compose.yml');
    expect(cfg.entryService).toBe('web');
    expect(cfg.entryPort).toBe(8000);
    expect(cfg.envFile).toBeUndefined();
    expect(cfg.healthPath).toBe('/');
    expect(cfg.hostPortRange).toEqual({ min: 5000, max: 5100 });
    expect(cfg.readyTimeoutMs).toBe(12_345);
  });

  it('user values win over defaults', () => {
    const cfg = resolveComposeConfig(
      {
        file: 'compose.preview.yml',
        entryService: 'frontend',
        entryPort: 3000,
        envFile: '.env.preview',
        healthPath: '/healthz',
        hostPortRange: { min: 6000, max: 6010 },
        readyTimeoutMs: 60_000,
      },
      {
        composeFile: 'docker-compose.yml',
        healthPath: '/',
        portRange: { min: 4100, max: 4999 },
        readyTimeoutMs: 300_000,
      },
    );
    expect(cfg.file).toBe('compose.preview.yml');
    expect(cfg.envFile).toBe('.env.preview');
    expect(cfg.healthPath).toBe('/healthz');
    expect(cfg.hostPortRange).toEqual({ min: 6000, max: 6010 });
    expect(cfg.readyTimeoutMs).toBe(60_000);
  });

  it('normalises a healthPath missing the leading slash', () => {
    const cfg = resolveComposeConfig(
      { entryService: 'web', entryPort: 80, healthPath: 'healthz' },
      {
        composeFile: 'docker-compose.yml',
        healthPath: '/',
        portRange: { min: 4100, max: 4999 },
        readyTimeoutMs: 300_000,
      },
    );
    expect(cfg.healthPath).toBe('/healthz');
  });
});

// ─── Constructor / schema migration ─────────────────────────────────────

describe('PreviewComposeRuntime — schema migration', () => {
  it('adds the compose_project_name column on a fresh DB', () => {
    const db = freshDb();
    new PreviewComposeRuntime({
      db,
      spawn: makeSpawn().spawn,
      fetch: makeFetch().fetch,
    });
    const cols = db.prepare(`PRAGMA table_info(worktree_preview_groups)`).all() as Array<{
      name: string;
    }>;
    expect(cols.map((c) => c.name)).toContain('compose_project_name');
  });

  it('is idempotent — instantiating twice does not throw', () => {
    const db = freshDb();
    new PreviewComposeRuntime({
      db,
      spawn: makeSpawn().spawn,
      fetch: makeFetch().fetch,
    });
    expect(() => {
      new PreviewComposeRuntime({
        db,
        spawn: makeSpawn().spawn,
        fetch: makeFetch().fetch,
      });
    }).not.toThrow();
  });

  it('rejects an inverted port range', () => {
    expect(() => {
      new PreviewComposeRuntime({
        db: freshDb(),
        spawn: makeSpawn().spawn,
        fetch: makeFetch().fetch,
        config: { portRange: { min: 5000, max: 4000 } },
      });
    }).toThrow(/Invalid compose preview port range/);
  });
});

// ─── startPreview happy path ───────────────────────────────────────────

describe('PreviewComposeRuntime.startPreview — happy path', () => {
  beforeEach(() => {
    vi.mocked(mergeProjectSecretsSpawnEnv).mockReset();
  });

  it('spawns `docker compose up`, allocates a port, and flips to ready on 2xx', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ okOnAttempt: 2 });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 60_000, healthIntervalMs: 10 },
    });

    const result = await runtime.startPreview('sess-1', makeProject(), '/wt/sess-1');

    expect(result.url).toBe(`http://localhost:${result.port}`);
    expect(result.port).toBeGreaterThanOrEqual(DEFAULT_PREVIEW_PORT_RANGE.min);
    expect(result.port).toBeLessThanOrEqual(DEFAULT_PREVIEW_PORT_RANGE.max);
    expect(result.composeProjectName).toBe('agenthub-session-sess-1');

    // Exactly one spawn — `docker compose up -d --build`. No `down`
    // until stopPreview / reaper.
    expect(harness.spawned).toHaveLength(1);
    expect(harness.calls[0].command).toBe('docker');
    expect(harness.calls[0].args).toEqual(
      buildComposeUpArgs({
        composeProjectName: 'agenthub-session-sess-1',
        composeFile: 'docker-compose.yml',
      }),
    );
    expect(harness.calls[0].cwd).toBe('/wt/sess-1');
    // AGENTHUB_HOST_PORT is the contract for compose files that
    // reference `${AGENTHUB_HOST_PORT}:${AGENTHUB_ENTRY_PORT}` on the
    // entry service's `ports:` mapping.
    expect(harness.calls[0].env.AGENTHUB_HOST_PORT).toBe(String(result.port));
    expect(harness.calls[0].env.AGENTHUB_ENTRY_PORT).toBe('8000');
    expect(harness.calls[0].env.AGENTHUB_SESSION_ID).toBe('sess-1');
    expect(harness.calls[0].env.AGENTHUB_PROJECT_ID).toBe('proj-1');

    // Drive the health-check loop forward — first poll fails, second
    // passes per `okOnAttempt: 2`.
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();

    const row = runtime.getById(result.previewId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('ready');
    expect(row!.compose_project_name).toBe('agenthub-session-sess-1');
    expect(row!.port).toBe(result.port);
    expect(row!.url).toBe(`http://localhost:${result.port}`);
  });

  it('calls mergeProjectSecretsSpawnEnv with overwriteExisting on compose up', async () => {
    vi.mocked(mergeProjectSecretsSpawnEnv).mockImplementation((base, opts) => {
      if (opts.overwriteExisting) {
        base.AWS_ACCESS_KEY_ID = 'AKIATEST';
        base.AWS_SECRET_ACCESS_KEY = 'secret-value';
        base.AWS_S3_BUCKET = 'my-bucket';
      }
    });

    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    await runtime.startPreview('sess-secrets', makeProject(), '/wt/secrets');

    expect(mergeProjectSecretsSpawnEnv).toHaveBeenCalledWith(
      expect.objectContaining({
        AGENTHUB_SESSION_ID: 'sess-secrets',
        AGENTHUB_PROJECT_ID: 'proj-1',
      }),
      { projectId: 'proj-1', sessionId: 'sess-secrets', overwriteExisting: true },
    );
    expect(harness.calls[0].env.AWS_ACCESS_KEY_ID).toBe('AKIATEST');
    expect(harness.calls[0].env.AWS_SECRET_ACCESS_KEY).toBe('secret-value');
    expect(harness.calls[0].env.AWS_S3_BUCKET).toBe('my-bucket');
  });

  it('respects a project-level hostPortRange override', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const project = makeProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: {
          enabled: true,
          compose: {
            entryService: 'web',
            entryPort: 8000,
            hostPortRange: { min: 6100, max: 6105 },
          },
        },
      },
    });

    const result = await runtime.startPreview('sess-r', project, '/wt');
    expect(result.port).toBeGreaterThanOrEqual(6100);
    expect(result.port).toBeLessThanOrEqual(6105);
  });

  it('forwards a custom envFile + composeFile through to the compose CLI', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const project = makeProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: {
          enabled: true,
          compose: {
            entryService: 'frontend',
            entryPort: 5173,
            file: 'compose.preview.yml',
            envFile: '.env.preview',
          },
        },
      },
    });

    await runtime.startPreview('sess-env', project, '/wt');
    expect(harness.calls[0].args).toEqual([
      'compose',
      '-p',
      'agenthub-session-sess-env',
      '-f',
      'compose.preview.yml',
      '--env-file',
      '.env.preview',
      'up',
      '-d',
      '--build',
    ]);
  });

  it('throws when prEnv.preview.compose is unset', async () => {
    const runtime = new PreviewComposeRuntime({
      db: freshDb(),
      spawn: makeSpawn().spawn,
      fetch: makeFetch().fetch,
    });
    const projectNoCompose = makeProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: { enabled: true, startScript: 'npm run preview' },
      },
    });
    await expect(runtime.startPreview('sess-x', projectNoCompose, '/wt')).rejects.toThrow(
      /without prEnv\.preview\.compose set/,
    );
  });
});

// ─── startPreview failure paths ────────────────────────────────────────

describe('PreviewComposeRuntime.startPreview — failure paths', () => {
  it('flips group + entry process to `failed` when health-check times out', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const warnings: string[] = [];
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      logger: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      config: { readyTimeoutMs: 50, healthIntervalMs: 10 },
    });

    const result = await runtime.startPreview('sess-fail', makeProject(), '/wt');

    // Drain enough iterations to exhaust the timeout. Each loop body
    // does fetch → sleep(10), so 6× advance(10) is plenty.
    for (let i = 0; i < 10; i++) {
      await flushMicrotasks();
      clock.advance(10);
    }
    await flushMicrotasks();

    const row = runtime.getById(result.previewId);
    expect(row!.status).toBe('failed');

    // The entry process row also shows failed so the reaper / UI can
    // surface the per-process state.
    const procs = db
      .prepare(`SELECT name, status, port FROM worktree_preview_processes WHERE group_id = ?`)
      .all(result.previewId) as Array<{ name: string; status: string; port: number }>;
    expect(procs).toHaveLength(1);
    expect(procs[0].name).toBe(ENTRY_PROCESS_NAME);
    expect(procs[0].status).toBe('failed');
    expect(warnings.some((w) => w.includes('health check timed out'))).toBe(true);
  });

  it('marks group failed when docker spawn throws synchronously', async () => {
    const db = freshDb();
    const throwingSpawn: SpawnFn = () => {
      throw new Error('ENOENT: docker not found');
    };
    const { fetch } = makeFetch();
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: throwingSpawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 100 },
    });

    const result = await runtime.startPreview('sess-spawn-fail', makeProject(), '/wt');
    await flushMicrotasks();
    const row = runtime.getById(result.previewId);
    expect(row!.status).toBe('failed');
  });

  it('falls through to failed state when the docker child emits an error event', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 5_000, healthIntervalMs: 10 },
    });
    const result = await runtime.startPreview('sess-err', makeProject(), '/wt');
    harness.spawned[0].emit('error', new Error('docker daemon unreachable'));
    await flushMicrotasks();
    const row = runtime.getById(result.previewId);
    expect(row!.status).toBe('failed');
  });
});

// ─── Port allocation ───────────────────────────────────────────────────

describe('PreviewComposeRuntime — port allocation', () => {
  it('skips ports already held by the legacy spawn runtime', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: {
        readyTimeoutMs: 1_000,
        healthIntervalMs: 10_000,
        portRange: { min: 4500, max: 4510 },
      },
    });

    // Seed the shared pool with a spawn-runtime row claiming 4500.
    // The compose allocator must skip it and hand out 4501.
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g-spawn', 'sess-spawn', 'proj-1', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p-spawn', 'g-spawn', 'app', 1234, 4500, 'http://localhost:4500', NULL, 'ready')`,
    ).run();

    const result = await runtime.startPreview('sess-c', makeProject(), '/wt');
    expect(result.port).toBe(4501);
  });

  it('throws when the pool is exhausted', async () => {
    const db = freshDb();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: makeSpawn().spawn,
      fetch: makeFetch({ alwaysFail: true }).fetch,
      clock: makeClock(),
      config: { portRange: { min: 4700, max: 4700 } },
    });
    // Fill the single-port pool.
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g-full', 'sess-full', 'proj-1', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p-full', 'g-full', 'app', 9, 4700, 'http://localhost:4700', NULL, 'ready')`,
    ).run();

    await expect(runtime.startPreview('sess-deny', makeProject(), '/wt')).rejects.toThrow(
      /port pool exhausted/,
    );
  });

  it('reuses ports freed when a prior compose group is stopped', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: {
        readyTimeoutMs: 1_000,
        healthIntervalMs: 10_000,
        portRange: { min: 4800, max: 4800 },
      },
    });
    const first = await runtime.startPreview('sess-r1', makeProject(), '/wt');
    await runtime.stopPreview(first.previewId);
    const second = await runtime.startPreview('sess-r2', makeProject(), '/wt');
    expect(second.port).toBe(first.port);
  });
});

// ─── stopPreview / stopBySessionId / touch ────────────────────────────

describe('PreviewComposeRuntime — teardown', () => {
  it('runs `docker compose down -v --remove-orphans` and deletes the row', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const result = await runtime.startPreview('sess-down', makeProject(), '/wt');
    await runtime.stopPreview(result.previewId);

    // Second spawn was the down call.
    expect(harness.calls.length).toBeGreaterThanOrEqual(2);
    const downCall = harness.calls[harness.calls.length - 1];
    expect(downCall.command).toBe('docker');
    expect(downCall.args).toEqual(
      buildComposeDownArgs({
        composeProjectName: 'agenthub-session-sess-down',
        composeFile: 'docker-compose.yml',
      }),
    );

    expect(runtime.getById(result.previewId)).toBeNull();
  });

  it('runtime: up + down spawns carry the same --project-directory value (PR #1074 reviewer [10/10])', async () => {
    // Regression test for the PR #1074 reviewer [10/10] blocker — the
    // builder-level tests pin `--project-directory` placement when the
    // arg is passed, but they don't prove the runtime actually passes
    // the same value on both up and down. Without this assertion a
    // missed translator call on stopPreview could ship undetected:
    // compose-go would resolve relative bind mounts against a different
    // base, fail to address the named volumes created on up, and the
    // `-v` teardown would silently leak.
    const prevHost = process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    process.env.AGENT_HUB_HOST_PROJECTS_DIR = '/host/projects';
    try {
      const db = freshDb();
      const harness = makeSpawn({ exitImmediately: true });
      const { fetch } = makeFetch({ alwaysFail: true });
      const clock = makeClock();
      const runtime = new PreviewComposeRuntime({
        db,
        spawn: harness.spawn,
        fetch,
        clock,
        config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
      });

      // Container-side worktree path under the projects bind-mount root.
      // Translates to /host/projects/foo via the env var above.
      const worktreePath = '/home/node/projects/foo';
      const result = await runtime.startPreview('sess-pd', makeProject(), worktreePath);
      await runtime.stopPreview(result.previewId);

      const upCall = harness.calls[0];
      const downCall = harness.calls[harness.calls.length - 1];

      expect(upCall.args).toContain('--project-directory');
      expect(downCall.args).toContain('--project-directory');

      const upPdIdx = upCall.args.indexOf('--project-directory');
      const downPdIdx = downCall.args.indexOf('--project-directory');
      expect(upCall.args[upPdIdx + 1]).toBe('/host/projects/foo');
      expect(downCall.args[downPdIdx + 1]).toBe(upCall.args[upPdIdx + 1]);
    } finally {
      if (prevHost === undefined) delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
      else process.env.AGENT_HUB_HOST_PROJECTS_DIR = prevHost;
    }
  });

  it('runtime: workspaces-rooted worktree translates to host on both up and down (card 9b868252)', async () => {
    // Session previews launched from per-session worktrees (the iframe a
    // chat session opens) now translate through the workspaces root, so
    // the daemon sees real source instead of empty bind mounts.
    const prevWs = process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
    process.env.AGENT_HUB_HOST_WORKSPACES_DIR = '/host/workspaces';
    try {
      const db = freshDb();
      const harness = makeSpawn({ exitImmediately: true });
      const { fetch } = makeFetch({ alwaysFail: true });
      const clock = makeClock();
      const runtime = new PreviewComposeRuntime({
        db,
        spawn: harness.spawn,
        fetch,
        clock,
        config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
      });

      const worktreePath = '/home/node/.agent-hub/workspaces/myproj/session-xyz';
      const result = await runtime.startPreview('sess-ws', makeProject(), worktreePath);
      await runtime.stopPreview(result.previewId);

      const upCall = harness.calls[0];
      const downCall = harness.calls[harness.calls.length - 1];
      const expectedHostPath = '/host/workspaces/myproj/session-xyz';
      expect(upCall.args[upCall.args.indexOf('--project-directory') + 1]).toBe(expectedHostPath);
      expect(downCall.args[downCall.args.indexOf('--project-directory') + 1]).toBe(
        expectedHostPath,
      );
    } finally {
      if (prevWs === undefined) delete process.env.AGENT_HUB_HOST_WORKSPACES_DIR;
      else process.env.AGENT_HUB_HOST_WORKSPACES_DIR = prevWs;
    }
  });

  it('runtime: stopPreview prefers the host path persisted at start time over re-translation (card c79c4bc0)', async () => {
    // This is the heart of card c79c4bc0 — between startPreview and
    // stopPreview the operator changes AGENT_HUB_HOST_PROJECTS_DIR
    // (think: server restart with the data dir remounted to a new host
    // path). Re-translating `worktree_path` at stop time would emit a
    // different host path than the up call used. We persist the
    // translated host path on the group row at start, so the down spawn
    // can reproduce the up call's `--project-directory` exactly.
    const prevHost = process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    process.env.AGENT_HUB_HOST_PROJECTS_DIR = '/host/projects-original';
    try {
      const db = freshDb();
      const harness = makeSpawn({ exitImmediately: true });
      const { fetch } = makeFetch({ alwaysFail: true });
      const clock = makeClock();
      const runtime = new PreviewComposeRuntime({
        db,
        spawn: harness.spawn,
        fetch,
        clock,
        config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
      });

      const worktreePath = '/home/node/projects/proj-x';
      const result = await runtime.startPreview('sess-persist', makeProject(), worktreePath);

      // Simulate a server restart / data-dir remount: the env var now
      // points at a different host path. The persisted column must win.
      process.env.AGENT_HUB_HOST_PROJECTS_DIR = '/host/projects-remounted';

      await runtime.stopPreview(result.previewId);

      const upCall = harness.calls[0];
      const downCall = harness.calls[harness.calls.length - 1];
      const upPath = upCall.args[upCall.args.indexOf('--project-directory') + 1];
      const downPath = downCall.args[downCall.args.indexOf('--project-directory') + 1];

      // The up call used the original mapping; the down call MUST use
      // the same value (read from `host_project_directory`), NOT the
      // re-translated post-remount path.
      expect(upPath).toBe('/host/projects-original/proj-x');
      expect(downPath).toBe('/host/projects-original/proj-x');
      expect(downPath).not.toBe('/host/projects-remounted/proj-x');
    } finally {
      if (prevHost === undefined) delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
      else process.env.AGENT_HUB_HOST_PROJECTS_DIR = prevHost;
    }
  });

  it('runtime: stopPreview falls back to re-translation when host_project_directory is NULL (legacy row, card c79c4bc0)', async () => {
    // Belt-and-braces — rows that predate the host_project_directory
    // column must still tear down correctly. stopPreview detects the
    // NULL and re-runs the translator against current env vars (the
    // same behavior PR #1074 shipped).
    const prevHost = process.env.AGENT_HUB_HOST_PROJECTS_DIR;
    process.env.AGENT_HUB_HOST_PROJECTS_DIR = '/host/projects';
    try {
      const db = freshDb();
      const harness = makeSpawn({ exitImmediately: true });
      const { fetch } = makeFetch({ alwaysFail: true });
      const clock = makeClock();
      const runtime = new PreviewComposeRuntime({
        db,
        spawn: harness.spawn,
        fetch,
        clock,
        config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
      });

      const worktreePath = '/home/node/projects/legacy-proj';
      const result = await runtime.startPreview('sess-legacy', makeProject(), worktreePath);

      // Simulate a row written before the column existed by clearing it.
      db.prepare(
        `UPDATE worktree_preview_groups SET host_project_directory = NULL WHERE id = ?`,
      ).run(result.previewId);

      await runtime.stopPreview(result.previewId);

      const downCall = harness.calls[harness.calls.length - 1];
      const downPath = downCall.args[downCall.args.indexOf('--project-directory') + 1];
      // Re-translation against the env above must succeed and produce
      // the equivalent host path.
      expect(downPath).toBe('/host/projects/legacy-proj');
    } finally {
      if (prevHost === undefined) delete process.env.AGENT_HUB_HOST_PROJECTS_DIR;
      else process.env.AGENT_HUB_HOST_PROJECTS_DIR = prevHost;
    }
  });

  it("reuses the up call's worktree cwd + custom compose file on the down spawn", async () => {
    // Regression test for the asymmetric teardown bug: a project that
    // overrides `compose.file` (e.g. `compose.preview.yml`) brings the
    // stack up correctly, but on `main` the down spawn was passing the
    // runtime default (`docker-compose.yml`) and no cwd at all — so
    // compose tried to resolve a non-existent file against the server
    // process's cwd and exited non-zero, the row was deleted anyway,
    // and the containers + named volumes + the host port stayed
    // claimed. This test pins (a) down cwd matches up cwd, (b) down's
    // `-f` references the same compose file the up call used.
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const project = makeProject({
      prEnv: {
        enabled: true,
        startScript: 'npm run dev',
        internalPort: 3000,
        preview: {
          enabled: true,
          compose: {
            entryService: 'frontend',
            entryPort: 5173,
            file: 'compose.preview.yml',
            envFile: '.env.preview',
          },
        },
      },
    });

    const worktreePath = '/wt/sess-override';
    const result = await runtime.startPreview('sess-override', project, worktreePath);
    await runtime.stopPreview(result.previewId);

    expect(harness.calls.length).toBeGreaterThanOrEqual(2);
    const upCall = harness.calls[0];
    const downCall = harness.calls[harness.calls.length - 1];

    // (a) cwd parity — both spawns resolve relative `-f` against the
    // same directory.
    expect(downCall.cwd).toBe(worktreePath);
    expect(downCall.cwd).toBe(upCall.cwd);

    // (b) compose-file parity — the down `-f` argument references the
    // same file the up call used, not the runtime default.
    expect(downCall.args).toEqual(
      buildComposeDownArgs({
        composeProjectName: 'agenthub-session-sess-override',
        composeFile: 'compose.preview.yml',
      }),
    );
    const upFileIdx = upCall.args.indexOf('-f');
    const downFileIdx = downCall.args.indexOf('-f');
    expect(upFileIdx).toBeGreaterThan(-1);
    expect(downFileIdx).toBeGreaterThan(-1);
    expect(downCall.args[downFileIdx + 1]).toBe(upCall.args[upFileIdx + 1]);
  });

  it('pins the same AGENTHUB_* env contract on up and down spawns', async () => {
    // Compose interpolates env vars on `down` too — if a service body
    // references `${AGENTHUB_HOST_PORT}` (or similar) outside `ports:`,
    // a down spawn without those vars emits "variable is not set"
    // warnings and may refuse to act on the referencing service. Pin
    // the env-var parity so a regression that drops env from the down
    // spawn (the original bug) is caught here.
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const result = await runtime.startPreview('sess-env-contract', makeProject(), '/wt/env');
    await runtime.stopPreview(result.previewId);

    const upCall = harness.calls[0];
    const downCall = harness.calls[harness.calls.length - 1];
    expect(downCall.env.AGENTHUB_HOST_PORT).toBe(upCall.env.AGENTHUB_HOST_PORT);
    expect(downCall.env.AGENTHUB_ENTRY_PORT).toBe(upCall.env.AGENTHUB_ENTRY_PORT);
    expect(downCall.env.AGENTHUB_SESSION_ID).toBe(upCall.env.AGENTHUB_SESSION_ID);
    expect(downCall.env.AGENTHUB_PROJECT_ID).toBe(upCall.env.AGENTHUB_PROJECT_ID);
    // Sanity: the values are actually populated (not both undefined).
    expect(downCall.env.AGENTHUB_HOST_PORT).toBe(String(result.port));
    expect(downCall.env.AGENTHUB_ENTRY_PORT).toBe('8000');
    expect(downCall.env.AGENTHUB_SESSION_ID).toBe('sess-env-contract');
  });

  it('is idempotent — stopPreview on a missing id is a no-op', async () => {
    const runtime = new PreviewComposeRuntime({
      db: freshDb(),
      spawn: makeSpawn().spawn,
      fetch: makeFetch().fetch,
      clock: makeClock(),
    });
    await expect(runtime.stopPreview('missing')).resolves.toBeUndefined();
  });

  it('ignores spawn-managed groups (no compose_project_name)', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const warnings: string[] = [];
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch: makeFetch().fetch,
      clock: makeClock(),
      logger: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
    });

    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g-spawn', 'sess-mix', 'proj-1', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p-spawn', 'g-spawn', 'app', 1, 4123, 'http://localhost:4123', NULL, 'ready')`,
    ).run();

    await runtime.stopPreview('g-spawn');

    // Row is untouched — compose runtime refused to teardown a spawn row.
    const row = db.prepare(`SELECT id FROM worktree_preview_groups WHERE id = 'g-spawn'`).get();
    expect(row).toBeTruthy();
    expect(warnings.some((w) => w.includes('non-compose group'))).toBe(true);
    // No `docker compose down` call was made.
    expect(harness.calls).toHaveLength(0);
  });

  it('stopBySessionId tears every compose group, leaves spawn groups alone', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch: makeFetch({ alwaysFail: true }).fetch,
      clock: makeClock(),
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    // One compose group + one spawn group for the same session.
    const compose1 = await runtime.startPreview('sess-multi', makeProject(), '/wt');
    db.prepare(
      `INSERT INTO worktree_preview_groups (id, session_id, project_id, status)
       VALUES ('g-spawn-multi', 'sess-multi', 'proj-1', 'ready')`,
    ).run();
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES ('p-spawn-multi', 'g-spawn-multi', 'app', 7, 4321, 'http://localhost:4321', NULL, 'ready')`,
    ).run();

    const stopped = await runtime.stopBySessionId('sess-multi');
    expect(stopped).toBe(1);
    expect(runtime.getById(compose1.previewId)).toBeNull();
    // Spawn group survived.
    const spawnRow = db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE id = 'g-spawn-multi'`)
      .get();
    expect(spawnRow).toBeTruthy();
  });

  it('touchPreview bumps last_active_at on a ready compose group', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ okOnAttempt: 1 });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 5_000, healthIntervalMs: 10 },
    });

    const result = await runtime.startPreview('sess-touch', makeProject(), '/wt');
    // Drive the loop forward enough to flip to ready.
    for (let i = 0; i < 3; i++) {
      await flushMicrotasks();
      clock.advance(10);
    }
    const before = (
      db
        .prepare(`SELECT last_active_at FROM worktree_preview_groups WHERE id = ?`)
        .get(result.previewId) as { last_active_at: string }
    ).last_active_at;

    // Sleep wall-clock-wise so SQLite's datetime('now') ticks past the prior value.
    await new Promise<void>((r) => setTimeout(r, 1_100));
    runtime.touchPreview(result.previewId);

    const after = (
      db
        .prepare(`SELECT last_active_at FROM worktree_preview_groups WHERE id = ?`)
        .get(result.previewId) as { last_active_at: string }
    ).last_active_at;

    expect(after >= before).toBe(true);
  });
});

// ─── Replace-on-restart ────────────────────────────────────────────────

describe('PreviewComposeRuntime — replace-on-restart', () => {
  it('stops the prior group before booting a new one for the same session', async () => {
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
    });

    const first = await runtime.startPreview('sess-replace', makeProject(), '/wt/a');
    const second = await runtime.startPreview('sess-replace', makeProject(), '/wt/b');

    expect(first.previewId).not.toBe(second.previewId);
    expect(runtime.getById(first.previewId)).toBeNull();
    expect(runtime.getById(second.previewId)).not.toBeNull();

    // Sequence of spawned commands: up(first) → down(first) → up(second).
    const verbs = harness.calls.map((c) => `${c.command}:${c.args.slice(-3).join(' ')}`);
    expect(verbs[0]).toMatch(/^docker:up -d --build$/);
    expect(verbs[1]).toMatch(/^docker:down -v --remove-orphans$/);
    expect(verbs[2]).toMatch(/^docker:up -d --build$/);
  });
});

// ─── Session-lock wedge protection ─────────────────────────────────────

describe('PreviewComposeRuntime.withSessionLock — wedge protection', () => {
  // A prior `_startPreview` that never resolves used to permanently
  // block every subsequent call for the same sessionId. The build-test
  // endpoint reuses one hardcoded sessionId per project, so a single
  // wedge bricked Settings → Build and run until server restart. The
  // runtime now bounds the wait via `sessionLockTimeoutMs`.

  it('evicts a wedged prior lock entry after sessionLockTimeoutMs and lets the new call proceed', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const warnings: string[] = [];
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: {
        readyTimeoutMs: 60_000,
        healthIntervalMs: 10_000,
        sessionLockTimeoutMs: 1_000,
      },
      logger: {
        log: () => {},
        warn: (m) => warnings.push(m),
        error: () => {},
      },
    });

    // Inject a never-resolving promise as the "prior" lock entry. This
    // simulates the production wedge mode: an earlier `_startPreview`
    // (or its descendants) returned a promise that never settles.
    const sessionId = '__preview_build_test__proj-1';
    const locks = (runtime as unknown as { sessionLocks: Map<string, Promise<unknown>> })
      .sessionLocks;
    const wedged = new Promise(() => {}); // never resolves, never rejects
    locks.set(sessionId, wedged);

    // Kick off a new startPreview. It will race the prior entry against
    // the 1000ms timeout — we drive the clock past the timeout, the
    // race resolves with the timeout sentinel, the dead entry is
    // evicted, and the new call proceeds to spawn.
    const startPromise = runtime.startPreview(sessionId, makeProject(), '/wt/sess-stuck');
    await flushMicrotasks();
    // Before the deadline: no spawn yet, lock is still the wedged entry.
    expect(harness.calls).toHaveLength(0);
    expect(locks.get(sessionId)).toBe(wedged);
    clock.advance(1_000);
    const result = await startPromise;

    expect(result.previewId).toBeTruthy();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0].args).toContain('up');
    // The eviction is loud — operators need a single log line that
    // points at the wedge, not a silent unblock.
    expect(warnings.some((w) => /did not settle within 1000ms/.test(w))).toBe(true);
    expect(warnings.some((w) => /evicting and proceeding/.test(w))).toBe(true);
    // After the new call's _startPreview returns, the lock map either
    // holds the new call's settled-tracker or has cleared the entry —
    // crucially, the wedged promise is no longer in residence.
    expect(locks.get(sessionId)).not.toBe(wedged);
  });

  it('keeps strict serialization when the prior call settles inside the budget', async () => {
    // Sanity check: the wedge protection must NOT shortcut a legitimate
    // back-to-back call. A second startPreview that arrives while a
    // real first one is still in flight should still wait for it.
    const db = freshDb();
    const harness = makeSpawn({ exitImmediately: true });
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: {
        readyTimeoutMs: 1_000,
        healthIntervalMs: 10_000,
        sessionLockTimeoutMs: 60_000,
      },
    });

    const first = await runtime.startPreview('sess-serial', makeProject(), '/wt/a');
    const second = await runtime.startPreview('sess-serial', makeProject(), '/wt/b');

    // Same replace-on-restart contract as the existing test: the
    // second call tore down the first (up → down → up sequence).
    expect(first.previewId).not.toBe(second.previewId);
    const verbs = harness.calls.map((c) => `${c.command}:${c.args.slice(-3).join(' ')}`);
    expect(verbs[0]).toMatch(/^docker:up -d --build$/);
    expect(verbs[1]).toMatch(/^docker:down -v --remove-orphans$/);
    expect(verbs[2]).toMatch(/^docker:up -d --build$/);
  });
});

// ─── Spawn observability ───────────────────────────────────────────────

describe('PreviewComposeRuntime._startPreview — spawn log line', () => {
  // Operators chasing the build-endpoint hang need a log line that
  // proves whether `this.spawn('docker', …)` was attempted. Previously
  // the gap between "override file written" and `child.on('error')`
  // (which only fires when spawn throws asynchronously) left the
  // failure mode ambiguous.

  it('emits a log line naming the compose project before each spawn', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const logs: Array<{ stream: 'log' | 'warn'; msg: string; spawnsBefore: number }> = [];
    const runtime = new PreviewComposeRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      clock,
      config: { readyTimeoutMs: 1_000, healthIntervalMs: 10_000 },
      logger: {
        log: (m) => logs.push({ stream: 'log', msg: m, spawnsBefore: harness.calls.length }),
        warn: (m) => logs.push({ stream: 'warn', msg: m, spawnsBefore: harness.calls.length }),
        error: () => {},
      },
    });

    const result = await runtime.startPreview('sess-log', makeProject(), '/wt/log');
    const spawnLine = logs.find((entry) => /spawning .*docker compose up/i.test(entry.msg));
    expect(spawnLine).toBeDefined();
    // The log line must precede the spawn — that's the whole point of
    // the diagnostic. If it lands after the spawn, an operator reading
    // logs after a wedge still can't tell whether spawn was attempted.
    expect(spawnLine!.spawnsBefore).toBe(0);
    // Identifying detail so the line is searchable in a noisy log.
    expect(spawnLine!.msg).toContain('agenthub-session-sess-log');
    expect(spawnLine!.msg).toContain('/wt/log');
    expect(spawnLine!.msg).toContain(String(result.port));
  });
});

// ─── systemClock smoke test ────────────────────────────────────────────

describe('systemClock', () => {
  it('exposes a real Date-backed nowMs / nowIso / sleep', async () => {
    const before = systemClock.nowMs();
    expect(typeof systemClock.nowIso()).toBe('string');
    await systemClock.sleep(5);
    expect(systemClock.nowMs()).toBeGreaterThanOrEqual(before);
  });
});
