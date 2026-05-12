/**
 * Unit tests for the worktree-preview runtime + reaper.
 *
 * Exercises the acceptance criteria spelled out on the kanban card:
 *   - startPreview boots a child process, allocates a port, returns a URL
 *   - health-check loop polls healthPath up to 30s before flipping ready
 *   - returns failed with first 50 log lines on timeout
 *   - reaper kills idle previews after idleTTL (2s in tests)
 *   - session-end test: preview stopped when its session is deleted
 *   - replace-on-restart test: two starts leave exactly one process and
 *     the prior port is freed
 *   - schema migration creates worktree_previews; row state matches
 *     process state across boot, idle-reap, session-end
 *
 * `child_process.spawn` and `fetch` are both replaced with deterministic
 * fakes via the runtime's dependency-injection seam, so no real network
 * or process is touched.
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import {
  PreviewRuntime,
  type Clock,
  type HealthFetchFn,
  type PreviewLogSink,
  type SpawnFn,
} from './preview-runtime.js';
import { runPreviewReaper } from './preview-reaper.js';
import type { Project } from '../types.js';
import type { ChildProcess } from 'child_process';

// ─── Test doubles ──────────────────────────────────────────────────

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
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
  emitData(stream: 'stdout' | 'stderr', chunk: string): void {
    this[stream].emit('data', Buffer.from(chunk, 'utf8'));
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
    port: string | undefined;
    env: Record<string, string | undefined>;
  }>;
  /** Injected kill dep — records calls and forwards signals to matching FakeChild. */
  kill: (target: number, signal: NodeJS.Signals) => void;
  killCalls: Array<{ target: number; signal: NodeJS.Signals }>;
}

function makeSpawn(): SpawnHarness {
  const spawned: FakeChild[] = [];
  const calls: SpawnHarness['calls'] = [];
  const killCalls: SpawnHarness['killCalls'] = [];
  let nextPid = 1000;
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild(nextPid++);
    spawned.push(child);
    const env = (options.env as Record<string, string | undefined> | undefined) ?? {};
    calls.push({
      command,
      args,
      cwd: options.cwd as string | undefined,
      port: env.PORT,
      env: { ...env },
    });
    return child as unknown as ChildProcess;
  };
  const kill = (target: number, signal: NodeJS.Signals): void => {
    killCalls.push({ target, signal });
    // Forward the signal to the matching FakeChild so waitForExit resolves.
    // In production the OS delivers the signal to the process group; here
    // we do it explicitly so tests don't depend on the ESRCH fallback path.
    const child = spawned.find((c) => -c.pid === target);
    child?.kill(signal);
  };
  return { spawn, spawned, calls, kill, killCalls };
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

function makeLogSink(): PreviewLogSink & { read(id: string): string } {
  const buffers = new Map<string, string[]>();
  return {
    open(previewId) {
      buffers.set(previewId, []);
      return {
        path: `/tmp/preview-${previewId}.log`,
        append(chunk) {
          buffers.get(previewId)?.push(chunk);
        },
      };
    },
    read(id) {
      return (buffers.get(id) ?? []).join('');
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
        startScript: 'npm run preview',
        idleTTL: 2,
      },
    },
    ...overrides,
  } as Project;
}

function freshDb(): Database.Database {
  return new Database(':memory:');
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('PreviewRuntime — startPreview', () => {
  it('creates the schema and inserts a `starting` row with the allocated port', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1, healthTimeoutMs: 1 },
    });

    const result = await runtime.startPreview('sess-1', makeProject(), '/wt/sess-1');

    expect(result.url).toBe(`http://localhost:${result.port}`);
    expect(result.port).toBeGreaterThanOrEqual(4100);
    expect(result.port).toBeLessThanOrEqual(4999);
    expect(harness.spawned).toHaveLength(1);
    expect(harness.calls[0].command).toBe('sh');
    expect(harness.calls[0].args).toEqual(['-c', 'npm run preview']);
    expect(harness.calls[0].port).toBe(String(result.port));
    expect(harness.calls[0].cwd).toBe('/wt/sess-1/client');

    const row = runtime.getById(result.previewId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('starting');
    expect(row!.session_id).toBe('sess-1');
    expect(row!.port).toBe(result.port);
    expect(row!.pid).toBe(harness.spawned[0].pid);
  });

  it('flips status to `ready` once the health check returns 2xx', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ okOnAttempt: 2 });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10, healthTimeoutMs: 5_000 },
    });

    const { previewId } = await runtime.startPreview('sess-ok', makeProject(), '/wt');

    // Drain the first poll (rejects), then advance to trigger the second.
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();
    clock.advance(10);
    await flushMicrotasks();

    const row = runtime.getById(previewId);
    expect(row!.status).toBe('ready');
  });

  it('flips status to `failed` and surfaces ≤50 log lines when health check times out', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 100, healthTimeoutMs: 250, logTailLines: 50 },
    });
    const { previewId } = await runtime.startPreview('sess-fail', makeProject(), '/wt');

    // Pump 60 stdout lines so we can verify the cap is 50.
    const child = harness.spawned[0];
    for (let i = 0; i < 60; i++) child.emitData('stdout', `boot line ${i}\n`);

    // Burn the deadline by advancing past the timeout. Each iteration:
    // (a) await the in-flight fetch reject, (b) the sleep promise, (c) the
    // next loop turn.
    for (let i = 0; i < 5; i++) {
      await flushMicrotasks();
      clock.advance(100);
    }
    await flushMicrotasks();

    const row = runtime.getById(previewId);
    expect(row!.status).toBe('failed');
    const tail = runtime.getLogTail(previewId);
    expect(tail.length).toBeLessThanOrEqual(50);
    expect(tail[0]).toBe('boot line 0');
  });

  it('replaces an existing preview when `startPreview` is called twice for the same session', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });

    const first = await runtime.startPreview('sess-restart', makeProject(), '/wt');
    const second = await runtime.startPreview('sess-restart', makeProject(), '/wt');

    expect(harness.spawned).toHaveLength(2);
    expect(harness.spawned[0].killed).toBe(true); // SIGTERM'd by replace
    expect(harness.spawned[1].killed).toBe(false);

    // Exactly one row left for this session — the new one.
    const rows = db
      .prepare(`SELECT id, port FROM worktree_previews WHERE session_id = ?`)
      .all('sess-restart') as Array<{ id: string; port: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second.previewId);

    // The first port is back in the free pool, so a new alloc could
    // pick it again. We verify the port's row was deleted.
    expect(runtime.getById(first.previewId)).toBeNull();
  });

  it('allocates ports lazily — two concurrent sessions get distinct ports', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const a = await runtime.startPreview('s-a', makeProject(), '/wt-a');
    const b = await runtime.startPreview('s-b', makeProject(), '/wt-b');
    expect(a.port).not.toBe(b.port);
  });

  it('throws when the port range is exhausted', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { portRange: { min: 5000, max: 5000 }, healthTimeoutMs: 1, healthIntervalMs: 1 },
    });
    await runtime.startPreview('s-1', makeProject(), '/wt');
    await expect(runtime.startPreview('s-2', makeProject(), '/wt')).rejects.toThrow(/exhausted/i);
  });

  it('falls back to `npm run dev` and `<wt>/client` when the project has no preview config', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const bareProject = { id: 'p', name: 'p', cwd: '/r', ahw: '/a' } as Project;
    await runtime.startPreview('s', bareProject, '/wt');
    expect(harness.calls[0].args).toEqual(['-c', 'npm run dev']);
    expect(harness.calls[0].cwd).toBe('/wt/client');
  });
});

describe('PreviewRuntime — stopPreview / stopBySessionId', () => {
  it('stopPreview is idempotent and frees the row', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const { previewId } = await runtime.startPreview('s', makeProject(), '/wt');
    await runtime.stopPreview(previewId);
    await runtime.stopPreview(previewId); // second call must not throw
    expect(runtime.getById(previewId)).toBeNull();
    expect(harness.spawned[0].killed).toBe(true);
  });

  it('killGroup sends SIGTERM to the process group (-pid) via the injected kill dep', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const { previewId } = await runtime.startPreview('s-kill', makeProject(), '/wt');
    const pid = harness.spawned[0].pid; // 1000

    await runtime.stopPreview(previewId);

    // The first call must be kill(-pid, 'SIGTERM') — the full process group.
    expect(harness.killCalls.length).toBeGreaterThanOrEqual(1);
    expect(harness.killCalls[0]).toEqual({ target: -pid, signal: 'SIGTERM' });
  });

  it('stopBySessionId tears down all active rows for the session (session-end hook)', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const a = await runtime.startPreview('s-end', makeProject(), '/wt');
    const stopped = await runtime.stopBySessionId('s-end');
    expect(stopped).toBe(1);
    expect(runtime.getById(a.previewId)).toBeNull();
    expect(harness.spawned[0].killed).toBe(true);
  });
});

describe('PreviewRuntime — stopPreview / markFailed', () => {
  it('marks the preview failed when the child exits during starting state', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10_000, healthTimeoutMs: 10_000 },
    });
    const { previewId } = await runtime.startPreview('s-crash', makeProject(), '/wt');
    expect(runtime.getById(previewId)!.status).toBe('starting');

    // Simulate the child exiting immediately (e.g. npm not found, wrong cwd).
    // exitWith sets exitCode before emitting 'exit' so markFailed's
    // waitForExit call returns immediately — no SIGTERM wait needed.
    harness.spawned[0].exitWith(1);

    // Allow the setImmediate that fires the 'exit' event to run, then
    // let the markFailed async chain settle.
    await new Promise<void>((r) => setImmediate(r));
    await flushMicrotasks();

    expect(runtime.getById(previewId)!.status).toBe('failed');
  });

  it('allows a different session to start on the same port after the prior session failed', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10_000, healthTimeoutMs: 10_000 },
    });

    // Session A: start → child exits immediately → port 4100 lands in 'failed' state.
    const { previewId: idA, port: portA } = await runtime.startPreview(
      's-failed',
      makeProject(),
      '/wt',
    );
    harness.spawned[0].exitWith(1);
    await new Promise<void>((r) => setImmediate(r));
    await flushMicrotasks();
    expect(runtime.getById(idA)!.status).toBe('failed');

    // Session B (different session_id): must succeed even though port A is held
    // by the 'failed' row. insertStartingRow should delete the stale row inline
    // and reuse the now-free port rather than spinning MAX_ATTEMPTS and throwing.
    const resultB = await runtime.startPreview('s-new', makeProject(), '/wt');

    expect(resultB.port).toBeGreaterThanOrEqual(4100);
    expect(runtime.getById(resultB.previewId)!.status).toBe('starting');
    // The failed row for session A was consumed by the inline cleanup.
    expect(runtime.getById(idA)).toBeNull();
    // The port is reused — portA is now the lowest free gap after the delete.
    expect(resultB.port).toBe(portA);
  });
});

describe('PreviewRuntime — touchPreview', () => {
  it('bumps last_active_at while the preview is starting/ready', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const { previewId } = await runtime.startPreview('s', makeProject(), '/wt');
    const before = runtime.getById(previewId)!.last_active_at;
    // SQLite's datetime('now') has 1-second resolution; the sleep is
    // deliberate — do not remove it. vi.useFakeTimers() won't help here
    // because datetime('now') reads the real wall clock, not the JS timer.
    await new Promise((r) => setTimeout(r, 1100));
    runtime.touchPreview(previewId);
    const after = runtime.getById(previewId)!.last_active_at;
    expect(after >= before).toBe(true);
    expect(after).not.toBe(before);
  });
});

describe('preview-reaper', () => {
  it('reaps a row whose last_active_at is older than the project idleTTL', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const project = makeProject(); // idleTTL = 2s
    const { previewId } = await runtime.startPreview('s-stale', project, '/wt');

    // Fast-forward last_active_at into the past so the reaper sees it stale.
    db.prepare(
      `UPDATE worktree_previews
          SET last_active_at = datetime('now', '-10 seconds')
        WHERE id = ?`,
    ).run(previewId);

    const result = await runPreviewReaper({
      db,
      runtime,
      getProject: () => project,
    });

    expect(result.scanned).toBe(1);
    expect(result.reaped).toBe(1);
    expect(runtime.getById(previewId)).toBeNull();
    expect(harness.spawned[0].killed).toBe(true);
  });

  it('leaves a freshly-active preview alone', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const project = makeProject(); // 2s TTL
    const { previewId } = await runtime.startPreview('s-fresh', project, '/wt');

    const result = await runPreviewReaper({
      db,
      runtime,
      getProject: () => project,
    });

    expect(result.reaped).toBe(0);
    expect(runtime.getById(previewId)).not.toBeNull();
  });

  it('treats a missing project as orphaned and reaps the row', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const { previewId } = await runtime.startPreview('s-orphan', makeProject(), '/wt');

    const result = await runPreviewReaper({
      db,
      runtime,
      getProject: () => null,
    });

    expect(result.orphaned).toBe(1);
    expect(runtime.getById(previewId)).toBeNull();
  });

  it('falls back to `defaultIdleTtlSeconds` when the project has no preview.idleTTL', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });
    const project = makeProject({ prEnv: { enabled: true, startScript: 'x', internalPort: 3000 } });
    const { previewId } = await runtime.startPreview('s', project, '/wt');
    db.prepare(
      `UPDATE worktree_previews SET last_active_at = datetime('now', '-5 seconds') WHERE id = ?`,
    ).run(previewId);

    const fresh = await runPreviewReaper({
      db,
      runtime,
      getProject: () => project,
      config: { defaultIdleTtlSeconds: 60 },
    });
    // 5s idle vs 60s TTL → not reaped.
    expect(fresh.reaped).toBe(0);

    const stale = await runPreviewReaper({
      db,
      runtime,
      getProject: () => project,
      config: { defaultIdleTtlSeconds: 1 },
    });
    expect(stale.reaped).toBe(1);
  });
});

describe('PreviewRuntime — loadProjectEnv merge', () => {
  it('merges resolver output into spawn env with PORT winning over a malicious entry', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const captured: Array<{ projectId: string; sessionId: string }> = [];
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
      loadProjectEnv: (projectId, ctx) => {
        captured.push({ projectId, sessionId: ctx.sessionId });
        return {
          DATABASE_URL: 'postgres://test',
          AWS_ACCESS_KEY_ID: 'AKIA-test',
          // A project secret named PORT MUST NOT redirect the dev server
          // off the runtime-allocated port — the runtime appends PORT
          // last so it always wins. If this assertion ever fails, the
          // health check would deadlock forever waiting on the wrong port.
          PORT: 'BAD-9999',
        };
      },
    });

    const result = await runtime.startPreview('sess-merge', makeProject(), '/wt');

    // The resolver was called with the correct projectId + sessionId.
    expect(captured).toEqual([{ projectId: 'proj-1', sessionId: 'sess-merge' }]);

    const env = harness.calls[0].env;
    expect(env.DATABASE_URL).toBe('postgres://test');
    expect(env.AWS_ACCESS_KEY_ID).toBe('AKIA-test');
    // PORT precedence — the runtime's allocated port wins over the
    // project's bogus value.
    expect(env.PORT).toBe(String(result.port));
    expect(env.PORT).not.toBe('BAD-9999');
    // process.env keys are still present (the merge is additive on top
    // of the parent env). PATH is reliably present in any test runner.
    expect(typeof env.PATH).toBe('string');
  });

  it('continues spawning (without project env) when loadProjectEnv throws', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const warnings: string[] = [];
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
      logger: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      loadProjectEnv: () => {
        throw new Error('store unavailable');
      },
    });

    const result = await runtime.startPreview('sess-err', makeProject(), '/wt');

    // Spawn still happened — historical behaviour is preserved.
    expect(harness.spawned).toHaveLength(1);
    expect(harness.calls[0].env.PORT).toBe(String(result.port));
    // The failure was logged so operators can diagnose missing secrets.
    expect(warnings.some((w) => w.includes('loadProjectEnv failed'))).toBe(true);
  });

  it('uses the historical merge (process.env + PORT) when loadProjectEnv is omitted', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
      // loadProjectEnv intentionally omitted.
    });

    const result = await runtime.startPreview('sess-bare', makeProject(), '/wt');
    expect(harness.calls[0].env.PORT).toBe(String(result.port));
    // No project keys leaked in — only inherited process.env + PORT.
    expect(harness.calls[0].env.DATABASE_URL).toBeUndefined();
  });
});

// ─── Helpers ───────────────────────────────────────────────────────

/**
 * Yield the event loop a few times so awaited promises chained off
 * fake clock + fake fetch settle before the next assertion. We do not
 * use `vi.useFakeTimers()` because the runtime sleeps via the injected
 * Clock, not setTimeout — so plain microtask flushing is sufficient.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
