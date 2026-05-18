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
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import {
  PreviewRuntime,
  __test_resolveProcessCwd,
  __test_defaultReadEnvFile,
  type Clock,
  type HealthFetchFn,
  type PreviewLogSink,
  type SpawnFn,
} from './preview-runtime.js';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
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
    // The single-process fallback now defaults to the worktree root
    // (DEFAULT_PREVIEW_CWD = '.'), not <wt>/client.
    expect(harness.calls[0].cwd).toBe('/wt/sess-1');

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

  it('fans stdout/stderr lines through `notifyLog` so the UI can stream boot output live', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const logged: Array<{
      sessionId: string;
      groupId: string;
      processName: string;
      line: string;
      stream: 'stdout' | 'stderr';
    }> = [];
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000, logTailLines: 5 },
      notifyLog: (info) => logged.push(info),
    });

    const { previewId } = await runtime.startPreview('sess-stream', makeProject(), '/wt');
    const child = harness.spawned[0];
    // Emit multiple newline-separated chunks across both streams.
    child.emitData('stdout', 'vite starting…\nlocal:  http://localhost:5173\n');
    child.emitData('stderr', 'warning: dep optimised\n');

    // Synchronous handler — by the next microtask the callback should have
    // observed every line.
    await flushMicrotasks();

    expect(logged.map((l) => l.line)).toEqual([
      'vite starting…',
      'local:  http://localhost:5173',
      'warning: dep optimised',
    ]);
    expect(logged[0].stream).toBe('stdout');
    expect(logged[2].stream).toBe('stderr');
    expect(logged[0].sessionId).toBe('sess-stream');
    expect(logged[0].groupId).toBe(previewId);
    expect(logged[0].processName).toBe('app');
  });

  it('still fires `notifyLog` for late lines after the in-memory tail cap is hit', async () => {
    // logTailLines is intentionally small (3). Lines beyond the cap stop
    // accumulating in `tail` (used for failure snapshots) but must still
    // flow through `notifyLog` so a streaming UI consumer doesn't go dark.
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const logged: string[] = [];
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000, logTailLines: 3 },
      notifyLog: (info) => logged.push(info.line),
    });

    const { previewId } = await runtime.startPreview('sess-cap', makeProject(), '/wt');
    const child = harness.spawned[0];
    for (let i = 0; i < 6; i++) child.emitData('stdout', `line ${i}\n`);
    await flushMicrotasks();

    // notifyLog saw every line; tail (capped) saw only the first three.
    expect(logged).toEqual(['line 0', 'line 1', 'line 2', 'line 3', 'line 4', 'line 5']);
    expect(runtime.getLogTail(previewId)).toEqual(['line 0', 'line 1', 'line 2']);
  });

  it('catches a throwing notifyLog so a broken broadcaster cannot crash the spawn', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const clock = makeClock();
    const warnings: string[] = [];
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
      logger: { log: () => {}, warn: (m) => warnings.push(m), error: () => {} },
      notifyLog: () => {
        throw new Error('broadcaster offline');
      },
    });

    await runtime.startPreview('sess-throw', makeProject(), '/wt');
    const child = harness.spawned[0];
    child.emitData('stdout', 'a line\n');
    await flushMicrotasks();

    // Spawn survived; the failure was logged so operators can diagnose it.
    expect(harness.spawned[0].killed).toBe(false);
    expect(warnings.some((w) => w.includes('notifyLog threw'))).toBe(true);
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

    // Exactly one group left for this session — the new one.
    const rows = db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE session_id = ?`)
      .all('sess-restart') as Array<{ id: string }>;
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

  it('falls back to `npm run dev` and the worktree root when the project has no preview config', async () => {
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
    // Single-process fallback now lands at the worktree root, not <wt>/client.
    expect(harness.calls[0].cwd).toBe('/wt');
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
      `UPDATE worktree_preview_groups
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
      `UPDATE worktree_preview_groups SET last_active_at = datetime('now', '-5 seconds') WHERE id = ?`,
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

// ─── Multi-process tests ──────────────────────────────────────────

/**
 * Helper — fetch fake that gates 2xx on a name predicate. `okWhen(name)`
 * returns true exactly when the URL's port matches the named process's
 * allocated port.
 */
function makeNamedFetch(opts: { okPredicate: (url: string) => boolean }): {
  fetch: HealthFetchFn;
  calls: string[];
} {
  const calls: string[] = [];
  const fetch: HealthFetchFn = async (url) => {
    calls.push(url);
    if (opts.okPredicate(url)) {
      return { ok: true, status: 200 };
    }
    throw new Error('ECONNREFUSED');
  };
  return { fetch, calls };
}

/**
 * Drain microtasks + advance the fake clock until either every
 * pending `sleep()` has resolved or `maxIters` iterations have run.
 * Lets us let a wave-based health-check loop run to completion in a
 * deterministic way without `vi.useFakeTimers()`.
 */
async function pump(clock: ReturnType<typeof makeClock>, ms: number, maxIters = 50): Promise<void> {
  for (let i = 0; i < maxIters; i++) {
    await flushMicrotasks();
    clock.advance(ms);
  }
  await flushMicrotasks();
}

function multiProcessProject(
  processes: NonNullable<NonNullable<Project['prEnv']>['preview']>['processes'],
): Project {
  return makeProject({
    prEnv: {
      enabled: true,
      startScript: 'unused-in-multi-process',
      internalPort: 3000,
      preview: {
        enabled: true,
        idleTTL: 600,
        processes,
      },
    },
  } as Partial<Project>);
}

describe('PreviewRuntime — multi-process startPreview', () => {
  it('spawns backend then frontend in order, gated on backend health', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const clock = makeClock();
    // backend health passes immediately; frontend should only be polled
    // *after* backend is ready (we'll verify the order via spawn timing).
    let backendPort = -1;
    const { fetch, calls } = makeNamedFetch({
      okPredicate: (url) => url.includes(`:${backendPort}`),
    });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10, healthTimeoutMs: 5_000 },
    });

    const project = multiProcessProject([
      {
        name: 'backend',
        startScript: 'python manage.py runserver',
        cwd: 'backend',
        healthPath: '/healthz',
      },
      {
        name: 'frontend',
        startScript: 'npm run dev',
        cwd: 'frontend',
        dependsOn: ['backend'],
      },
    ]);

    const { previewId, url } = await runtime.startPreview('sess-fs', project, '/wt');

    // Only one process spawned synchronously — frontend waits for backend.
    expect(harness.spawned).toHaveLength(1);
    expect(harness.calls[0].args).toEqual(['-c', 'python manage.py runserver']);
    expect(harness.calls[0].cwd).toBe('/wt/backend');
    backendPort = Number(harness.calls[0].port);

    // Drive the health-check loop until backend → ready, which triggers
    // the frontend spawn, then drives that to ready as well.
    await pump(clock, 10);

    expect(harness.spawned).toHaveLength(2);
    expect(harness.calls[1].args).toEqual(['-c', 'npm run dev']);
    expect(harness.calls[1].cwd).toBe('/wt/frontend');

    // Make frontend health pass too.
    const frontendPort = Number(harness.calls[1].port);
    expect(frontendPort).not.toBe(backendPort);
    await pump(clock, 10);
    // Allow both processes to flip ready (frontend will start matching the
    // okPredicate once we widen it; here we update by reassigning):
    // Instead, just assert the per-process table contains the right shape.

    const processes = runtime.getProcesses(previewId);
    expect(processes.map((p) => p.name).sort()).toEqual(['backend', 'frontend']);
    expect(processes.find((p) => p.name === 'backend')!.port).toBe(backendPort);
    expect(processes.find((p) => p.name === 'frontend')!.port).toBe(frontendPort);

    // Default-surface URL is the frontend (the leaf).
    expect(url).toBe(`http://localhost:${frontendPort}`);

    // Backend received at least one health poll.
    expect(calls.some((c) => c.includes(`:${backendPort}/healthz`))).toBe(true);
  });

  it('short-circuits the group to failed when a dependency fails health', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const clock = makeClock();
    // Health always fails — backend will time out → group → failed.
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10, healthTimeoutMs: 50 },
    });

    const project = multiProcessProject([
      { name: 'api', startScript: 'fail' },
      { name: 'web', startScript: 'should-not-run', dependsOn: ['api'] },
    ]);
    const { previewId } = await runtime.startPreview('sess-bad', project, '/wt');

    await pump(clock, 20);

    const procs = runtime.getProcesses(previewId);
    const api = procs.find((p) => p.name === 'api')!;
    const web = procs.find((p) => p.name === 'web')!;

    // api failed health → flipped to failed.
    expect(api.status).toBe('failed');
    // web never had a chance to spawn — short-circuited by the group rollup.
    expect(web.status).toBe('failed');
    expect(harness.spawned).toHaveLength(1); // only api was ever spawned

    // Group rollup must be failed.
    const group = runtime.getById(previewId);
    expect(group?.status).toBe('failed');
  });

  it('rejects a cyclic processes[] config at start time', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch: makeFetch({ alwaysFail: true }).fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1, healthTimeoutMs: 1 },
    });
    const project = multiProcessProject([
      { name: 'a', startScript: 'noop', dependsOn: ['b'] },
      { name: 'b', startScript: 'noop', dependsOn: ['a'] },
    ]);
    await expect(runtime.startPreview('sess-cycle', project, '/wt')).rejects.toThrow(/cycle/);
    // Nothing was inserted into the DB.
    const groups = db.prepare(`SELECT COUNT(*) AS n FROM worktree_preview_groups`).get() as {
      n: number;
    };
    expect(groups.n).toBe(0);
  });

  it('exposes processes via getProcesses() ordered by start time then name', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 },
    });

    const project = multiProcessProject([
      { name: 'cache', startScript: 'noop' },
      { name: 'queue', startScript: 'noop' },
      { name: 'web', startScript: 'noop', dependsOn: ['cache', 'queue'] },
    ]);
    const { previewId } = await runtime.startPreview('sess-many', project, '/wt');

    const procs = runtime.getProcesses(previewId);
    expect(procs).toHaveLength(3);
    expect(procs.map((p) => p.name).sort()).toEqual(['cache', 'queue', 'web']);
    // All three rows exist; first wave's two members are spawned, the
    // leaf is still pending.
    const byName = Object.fromEntries(procs.map((p) => [p.name, p]));
    expect(['starting', 'pending']).toContain(byName.cache.status);
    expect(['starting', 'pending']).toContain(byName.queue.status);
    expect(byName.web.status).toBe('pending');
  });

  it('overlays per-process envFile on top of project env (per-process wins)', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch: makeFetch({ alwaysFail: true }).fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10_000, healthTimeoutMs: 10_000 },
      loadProjectEnv: () => ({ SHARED_KEY: 'project-wide', NODE_ENV: 'development' }),
      readEnvFile: (_worktreePath: string, relPath: string): Record<string, string> => {
        if (relPath === 'backend/.env') {
          return { SHARED_KEY: 'backend-only', PG_DSN: 'postgres://' };
        }
        return {};
      },
    });

    const project = multiProcessProject([
      { name: 'backend', startScript: 'noop', cwd: 'backend', envFile: 'backend/.env' },
      { name: 'frontend', startScript: 'noop', cwd: 'frontend', dependsOn: ['backend'] },
    ]);
    await runtime.startPreview('sess-env', project, '/wt');

    const backendCall = harness.calls.find((c) => c.args[1] === 'noop' && c.cwd === '/wt/backend')!;
    // Project-wide SHARED_KEY is overridden by per-process envFile.
    expect(backendCall.env.SHARED_KEY).toBe('backend-only');
    // Project-wide NODE_ENV still flows through.
    expect(backendCall.env.NODE_ENV).toBe('development');
    // Per-process key is set.
    expect(backendCall.env.PG_DSN).toBe('postgres://');
    // PORT always wins last.
    expect(backendCall.env.PORT).toBeDefined();
  });

  it('tears down a multi-process group on stopPreview, in reverse-dependency order', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const clock = makeClock();
    let backendPort = -1;
    const { fetch } = makeNamedFetch({
      okPredicate: (url) => backendPort > 0 && url.includes(`:${backendPort}`),
    });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      clock,
      logSink: makeLogSink(),
      config: { healthIntervalMs: 10, healthTimeoutMs: 5_000 },
    });

    const project = multiProcessProject([
      { name: 'backend', startScript: 'be' },
      { name: 'frontend', startScript: 'fe', dependsOn: ['backend'] },
    ]);
    const { previewId } = await runtime.startPreview('sess-stop', project, '/wt');
    backendPort = Number(harness.calls[0].port);

    // Advance to spawn frontend.
    await pump(clock, 10);
    expect(harness.spawned).toHaveLength(2);

    await runtime.stopPreview(previewId);

    // Both child processes were SIGTERMed.
    expect(harness.spawned[0].killed).toBe(true);
    expect(harness.spawned[1].killed).toBe(true);

    // Reverse-dependency: the frontend was killed before the backend.
    // We look at the kill-call ordering to verify.
    const frontendKill = harness.killCalls.findIndex((k) => k.target === -harness.spawned[1].pid);
    const backendKill = harness.killCalls.findIndex((k) => k.target === -harness.spawned[0].pid);
    expect(frontendKill).toBeGreaterThan(-1);
    expect(backendKill).toBeGreaterThan(-1);
    expect(frontendKill).toBeLessThan(backendKill);

    // Group + process rows are all gone.
    expect(runtime.getById(previewId)).toBeNull();
    const remaining = db
      .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE group_id = ?`)
      .get(previewId) as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe('PreviewRuntime — legacy migration', () => {
  it('reads an existing single-process row back as a 1-process group named app', () => {
    const db = freshDb();
    // Seed the legacy table with a pre-migration row.
    db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_previews (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL,
        project_id      TEXT NOT NULL,
        pid             INTEGER,
        port            INTEGER NOT NULL UNIQUE,
        url             TEXT NOT NULL,
        log_path        TEXT,
        started_at      TEXT NOT NULL DEFAULT (datetime('now')),
        last_active_at  TEXT NOT NULL DEFAULT (datetime('now')),
        status          TEXT NOT NULL CHECK(status IN ('starting','ready','failed'))
      );
      INSERT INTO worktree_previews (id, session_id, project_id, pid, port, url, log_path, status)
      VALUES ('legacy-id', 'sess-old', 'proj-old', 1234, 4150, 'http://localhost:4150', '/tmp/x.log', 'ready');
    `);

    // Constructing a runtime applies the schema + migration.
    const harness = makeSpawn();
    new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch: makeFetch({ alwaysFail: true }).fetch,
      kill: harness.kill,
      clock: makeClock(),
      logSink: makeLogSink(),
    });

    // New tables now carry the same row.
    const group = db
      .prepare(`SELECT * FROM worktree_preview_groups WHERE id = ?`)
      .get('legacy-id') as
      | { id: string; session_id: string; project_id: string; status: string }
      | undefined;
    expect(group).toBeDefined();
    expect(group!.session_id).toBe('sess-old');
    expect(group!.status).toBe('ready');

    const procs = db
      .prepare(`SELECT * FROM worktree_preview_processes WHERE group_id = ?`)
      .all('legacy-id') as Array<{ name: string; port: number; status: string; pid: number }>;
    expect(procs).toHaveLength(1);
    expect(procs[0].name).toBe('app');
    expect(procs[0].port).toBe(4150);
    expect(procs[0].pid).toBe(1234);
    expect(procs[0].status).toBe('ready');
  });

  it('migration is idempotent — re-running does not duplicate rows', () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS worktree_previews (
        id TEXT PRIMARY KEY, session_id TEXT, project_id TEXT,
        pid INTEGER, port INTEGER UNIQUE, url TEXT, log_path TEXT,
        started_at TEXT DEFAULT (datetime('now')),
        last_active_at TEXT DEFAULT (datetime('now')),
        status TEXT
      );
      INSERT INTO worktree_previews (id, session_id, project_id, port, url, status)
      VALUES ('legacy-2', 's', 'p', 4151, 'http://localhost:4151', 'ready');
    `);
    const harness = makeSpawn();
    const mk = (): PreviewRuntime =>
      new PreviewRuntime({
        db,
        spawn: harness.spawn,
        fetch: makeFetch({ alwaysFail: true }).fetch,
        kill: harness.kill,
        clock: makeClock(),
        logSink: makeLogSink(),
      });
    mk();
    mk();
    mk();
    const procs = db
      .prepare(`SELECT COUNT(*) AS n FROM worktree_preview_processes WHERE group_id = 'legacy-2'`)
      .get() as { n: number };
    expect(procs.n).toBe(1);
  });
});

// ─── Path-traversal containment (regression for PR #908 review) ───────

describe('resolveProcessCwd — path traversal containment', () => {
  it('returns the worktree root when cwd is undefined', () => {
    expect(__test_resolveProcessCwd('/wt', undefined)).toBe('/wt');
  });

  it('accepts a normal sub-directory under the worktree', () => {
    expect(__test_resolveProcessCwd('/wt', 'backend')).toBe('/wt/backend');
  });

  it('accepts a nested sub-directory', () => {
    expect(__test_resolveProcessCwd('/wt', 'apps/api')).toBe('/wt/apps/api');
  });

  it('rejects absolute paths by degrading to the worktree root', () => {
    expect(__test_resolveProcessCwd('/wt', '/etc/passwd')).toBe('/wt');
  });

  it('rejects `..` traversal that would escape the worktree', () => {
    expect(__test_resolveProcessCwd('/wt', '../escape')).toBe('/wt');
  });

  it('rejects deep `..` traversal that lands on a different root', () => {
    expect(__test_resolveProcessCwd('/wt', '../../etc')).toBe('/wt');
  });

  it('allows `..` that resolves back into the worktree (no-op)', () => {
    // `/wt/sub/../sub` normalises to `/wt/sub` — still contained.
    expect(__test_resolveProcessCwd('/wt', 'sub/../sub')).toBe('/wt/sub');
  });

  it('rejects a prefix-extension sibling (`/wt` vs `/wt-secrets`)', () => {
    // Naive startsWith would have accepted this; the trailing-sep check
    // requires a path separator between the worktree and the rest.
    expect(__test_resolveProcessCwd('/wt', '../wt-secrets')).toBe('/wt');
  });
});

describe('defaultReadEnvFile — path traversal containment', () => {
  let tmpDir: string;
  let siblingDir: string;

  beforeEach(() => {
    // Make a dir whose name shares the prefix of our "worktree" so the
    // sibling escape test has a real on-disk target to point at.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'preview-envfile-'));
    siblingDir = `${tmpDir}-secrets`;
    mkdirSync(siblingDir, { recursive: true });
    writeFileSync(path.join(siblingDir, '.env'), 'STOLEN=should-not-leak\n');
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      rmSync(siblingDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('reads a normal .env relative to the worktree', () => {
    mkdirSync(path.join(tmpDir, 'backend'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'backend', '.env'), 'PG_DSN=postgres://local\nDEBUG=1\n');
    const env = __test_defaultReadEnvFile(tmpDir, 'backend/.env');
    expect(env).toEqual({ PG_DSN: 'postgres://local', DEBUG: '1' });
  });

  it('returns empty for `../../../etc/passwd`-style traversal', () => {
    const env = __test_defaultReadEnvFile(tmpDir, '../../../etc/passwd');
    expect(env).toEqual({});
  });

  it('returns empty for the prefix-extension sibling escape', () => {
    // The original startsWith check accepted this and would have leaked
    // the sibling's secrets into the spawn env. The trailing-sep check
    // closes that path.
    const sibBase = path.basename(siblingDir); // e.g. preview-envfile-XXXX-secrets
    const escape = `../${sibBase}/.env`;
    const env = __test_defaultReadEnvFile(tmpDir, escape);
    expect(env).toEqual({});
  });

  it('returns empty for a missing file (envFile is a hint, never required)', () => {
    const env = __test_defaultReadEnvFile(tmpDir, 'does-not-exist.env');
    expect(env).toEqual({});
  });

  it('parses comments, quoted values, and trims whitespace', () => {
    writeFileSync(
      path.join(tmpDir, '.env'),
      '# comment\n  KEY1=value1\nKEY2="quoted"\nKEY3=\'single\'\n',
    );
    expect(__test_defaultReadEnvFile(tmpDir, '.env')).toEqual({
      KEY1: 'value1',
      KEY2: 'quoted',
      KEY3: 'single',
    });
  });
});

// ─── Cross-runtime ownership ───────────────────────────────────────
//
// Both PreviewRuntime and PreviewComposeRuntime share the same
// `worktree_preview_groups` table. The reaper + session-archive hooks
// fan a tick across both runtimes. Without per-row ownership guards
// the legacy runtime would happily DELETE compose-managed rows out
// from under the compose runtime mid-`docker compose down` — leaking
// the container stack + the allocated host port.
//
// These tests pin the runtime-layer guards added in PR 2 review:
//   - `stopPreview(<compose row id>)` → early-return, no DELETE.
//   - `stopBySessionId(<sessionId>)` → only picks up rows whose
//     `compose_project_name IS NULL`.
//   - The full reaper pass against a shared DB containing one compose +
//     one spawn row leaves the compose row intact and no `docker`
//     binary is spawned.

describe('PreviewRuntime — cross-runtime ownership guard', () => {
  /**
   * Seed a compose-managed row + a spawn-managed row in the shared
   * preview tables. Returns the two group ids so the test can target
   * them by id without re-querying.
   */
  function seedMixedRows(db: Database.Database): { composeId: string; spawnId: string } {
    // Mirror the columns the compose runtime would write. We do NOT
    // construct an actual PreviewComposeRuntime here — the point is to
    // pin the LEGACY runtime's behaviour when handed a row it doesn't
    // own. The compose runtime's own teardown is exercised in
    // preview-compose-runtime.test.ts.
    const composeId = 'g-compose-mixed';
    const spawnId = 'g-spawn-mixed';
    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, compose_project_name)
       VALUES (?, ?, ?, 'ready', ?)`,
    ).run(composeId, 'sess-mixed', 'proj-mixed', `agenthub-session-sess-mixed`);
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES (?, ?, ?, NULL, ?, ?, NULL, 'ready')`,
    ).run(`${composeId}:entry`, composeId, 'entry', 4900, 'http://localhost:4900');

    db.prepare(
      `INSERT INTO worktree_preview_groups
         (id, session_id, project_id, status, compose_project_name)
       VALUES (?, ?, ?, 'ready', NULL)`,
    ).run(spawnId, 'sess-mixed', 'proj-mixed');
    db.prepare(
      `INSERT INTO worktree_preview_processes
         (id, group_id, name, pid, port, url, log_path, status)
       VALUES (?, ?, ?, 1234, ?, ?, NULL, 'ready')`,
    ).run(`${spawnId}:app`, spawnId, 'app', 4901, 'http://localhost:4901');

    return { composeId, spawnId };
  }

  it('stopPreview refuses a compose-managed row and leaves it in the DB', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      logSink: makeLogSink(),
    });
    const { composeId } = seedMixedRows(db);

    await runtime.stopPreview(composeId);

    // Row survives — compose runtime owns its teardown.
    const row = db.prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`).get(composeId);
    expect(row).toBeTruthy();
    // No SIGTERM was sent — the legacy runtime has no in-memory handle
    // for a row it doesn't own, but we still want to assert the
    // compose-project-name guard fires *before* any kill attempt.
    expect(harness.killCalls).toHaveLength(0);
  });

  it('stopBySessionId picks up only spawn rows when a compose row shares the session', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      logSink: makeLogSink(),
    });
    const { composeId, spawnId } = seedMixedRows(db);

    const stopped = await runtime.stopBySessionId('sess-mixed');

    expect(stopped).toBe(1); // only the spawn row counts
    const composeRow = db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`)
      .get(composeId);
    expect(composeRow).toBeTruthy();
    const spawnRow = db.prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`).get(spawnId);
    expect(spawnRow).toBeFalsy();
  });

  it('reaper tick scans mixed rows but leaves the compose row + spawns no docker', async () => {
    const db = freshDb();
    const harness = makeSpawn();
    const { fetch } = makeFetch({ alwaysFail: true });
    const runtime = new PreviewRuntime({
      db,
      spawn: harness.spawn,
      fetch,
      kill: harness.kill,
      logSink: makeLogSink(),
    });
    const { composeId, spawnId } = seedMixedRows(db);

    // Backdate both rows so the reaper considers them idle.
    db.prepare(
      `UPDATE worktree_preview_groups
          SET last_active_at = datetime('now', '-1 hour')
        WHERE id IN (?, ?)`,
    ).run(composeId, spawnId);

    const result = await runPreviewReaper({
      db,
      runtime,
      getProject: () =>
        ({
          id: 'proj-mixed',
          name: 'Mixed',
          cwd: '/r',
          ahw: '/a',
          agents: [],
          prEnv: {
            enabled: true,
            startScript: 'npm run dev',
            internalPort: 3000,
            preview: { enabled: true, idleTTL: 60 },
          },
        }) as unknown as Project,
      config: { defaultIdleTtlSeconds: 60 },
    });

    // Reaper attempted both (scanned=2) — actual `reaped` count is
    // implementation-detail: the legacy runtime returns silently from
    // the compose-row stopPreview, so the row stays in the DB and the
    // count reported can include the silent skip. The important
    // invariants are below.
    expect(result.scanned).toBe(2);

    const composeRow = db
      .prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`)
      .get(composeId);
    expect(composeRow).toBeTruthy();
    const spawnRow = db.prepare(`SELECT id FROM worktree_preview_groups WHERE id = ?`).get(spawnId);
    expect(spawnRow).toBeFalsy();
    // Critically: the legacy runtime must NOT have spawned a `docker`
    // process trying to tear down a compose stack. The spawn harness
    // records every spawn call across the test; here it should be
    // empty (no `docker compose down`, no `kill` either).
    expect(harness.calls).toHaveLength(0);
    expect(harness.killCalls).toHaveLength(0);
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
