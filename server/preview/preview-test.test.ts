/**
 * Unit tests for the one-shot preview test runner.
 *
 * Exercises the contract spelled out on the kanban card:
 *   - Returns 400-shaped error when preview not enabled or cwd missing
 *   - Spawns startScript with PORT, polls healthPath, screenshots on 2xx
 *   - Tears down the spawned process in a `finally` (no leaks)
 *   - Surfaces meaningful errors for port-allocation / spawn-ENOENT /
 *     health-timeout / premature child exit
 *
 * All IO (spawn, fetch, clock, port allocation, screenshot, kill) is
 * injected — no real network or child process is touched.
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ChildProcess } from 'child_process';
import {
  runPreviewTest,
  type PreviewTestSpawnFn,
  type PreviewTestHealthFetchFn,
  type PreviewTestClock,
} from './preview-test.js';
import type { Project } from '../types.js';

// ─── Fakes ─────────────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    setImmediate(() => this.emit('exit', null, signal));
    return true;
  }
}

interface SpawnHarness {
  spawn: PreviewTestSpawnFn;
  spawned: FakeChild[];
  calls: Array<{ args: readonly string[]; port: string | undefined; cwd: string | undefined }>;
  kill: (target: number, signal: NodeJS.Signals) => void;
  killSignals: NodeJS.Signals[];
}

function makeSpawn(): SpawnHarness {
  const spawned: FakeChild[] = [];
  const calls: SpawnHarness['calls'] = [];
  const killSignals: NodeJS.Signals[] = [];
  let nextPid = 5000;
  const spawn: PreviewTestSpawnFn = (_cmd, args, options) => {
    const child = new FakeChild(nextPid++);
    spawned.push(child);
    calls.push({
      args,
      port: (options.env as Record<string, string> | undefined)?.PORT,
      cwd: options.cwd as string | undefined,
    });
    return child as unknown as ChildProcess;
  };
  const kill = (target: number, signal: NodeJS.Signals): void => {
    killSignals.push(signal);
    const ch = spawned.find((c) => -c.pid === target || c.pid === target);
    ch?.kill(signal);
  };
  return { spawn, spawned, calls, kill, killSignals };
}

function makeFetch(
  behaviour: { okOnAttempt?: number; nonOkStatus?: number; alwaysFail?: boolean } = {},
): { fetch: PreviewTestHealthFetchFn; attempts: () => number } {
  let attempts = 0;
  const fetch: PreviewTestHealthFetchFn = async () => {
    attempts++;
    if (behaviour.alwaysFail) throw new Error('ECONNREFUSED');
    if (behaviour.okOnAttempt && attempts >= behaviour.okOnAttempt) {
      return { ok: true, status: 200 };
    }
    if (behaviour.nonOkStatus) return { ok: false, status: behaviour.nonOkStatus };
    throw new Error('ECONNREFUSED');
  };
  return { fetch, attempts: () => attempts };
}

function makeClock(): PreviewTestClock & { advance(ms: number): void } {
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
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        sleeps.push({ resolveAt: nowMs + ms, resolve });
      }),
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
      enabled: false,
      preview: {
        enabled: true,
        startScript: 'npm run dev',
        idleTTL: 600,
        captureRoutes: ['/'],
      },
      healthPath: '/',
    },
    ...overrides,
  } as Project;
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('runPreviewTest — validation', () => {
  it('returns ok:false when preview is not enabled', async () => {
    const result = await runPreviewTest({
      project: makeProject({
        prEnv: { enabled: false, preview: { enabled: false } },
      } as Partial<Project>),
      uploadsDir: '/tmp/uploads',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not enabled/i);
    expect(result.ports.allocated).toBeNull();
  });

  it('returns ok:false when project has no cwd', async () => {
    const result = await runPreviewTest({
      project: makeProject({ cwd: '' as unknown as string }),
      uploadsDir: '/tmp/uploads',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/cwd/i);
  });
});

describe('runPreviewTest — happy path', () => {
  it('spawns startScript with PORT, polls health, captures screenshot, tears down', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'preview-test-'));
    try {
      const harness = makeSpawn();
      const clock = makeClock();
      const { fetch } = makeFetch({ okOnAttempt: 3 });
      const screenshots: Array<{ url: string; out: string }> = [];

      const promise = runPreviewTest({
        project: makeProject(),
        uploadsDir: tmp,
        publicUrl: 'https://hub.example.com',
        spawn: harness.spawn,
        fetch,
        clock,
        kill: harness.kill,
        allocatePort: async () => 4200,
        captureScreenshot: async (url, out) => {
          screenshots.push({ url, out });
          // Touch the file so existsSync passes downstream
          const { writeFileSync } = await import('fs');
          writeFileSync(out, Buffer.from('fake-png'));
        },
        healthIntervalMs: 100,
      });

      // Drive the clock forward to release the sleep(100) calls.
      // Three polls (attempts 1,2,3) — fetch reports ok on attempt 3.
      // We advance the clock between awaited slumbers; runPreviewTest is
      // single-threaded inside the loop so a few microtasks + clock
      // advances are enough.
      for (let i = 0; i < 5; i++) {
        await Promise.resolve();
        clock.advance(120);
      }

      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.ports.allocated).toBe(4200);
      expect(result.screenshotUrl).toBe(
        'https://hub.example.com/uploads/preview-tests/' + path.basename(screenshots[0].out),
      );
      expect(harness.calls[0]?.port).toBe('4200');
      expect(harness.calls[0]?.args).toEqual(['-c', 'npm run dev']);
      expect(harness.calls[0]?.cwd).toBe('/repo/client');
      expect(screenshots).toHaveLength(1);
      expect(screenshots[0].url).toBe('http://localhost:4200/');
      // Teardown: SIGTERM sent to the spawned child
      expect(harness.killSignals).toContain('SIGTERM');
      // Process was actually terminated
      expect(harness.spawned[0].signalCode).toBe('SIGTERM');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns relative screenshot URL when no publicUrl is configured', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'preview-test-'));
    try {
      const harness = makeSpawn();
      const clock = makeClock();
      const { fetch } = makeFetch({ okOnAttempt: 1 });

      const promise = runPreviewTest({
        project: makeProject(),
        uploadsDir: tmp,
        spawn: harness.spawn,
        fetch,
        clock,
        kill: harness.kill,
        allocatePort: async () => 4250,
        captureScreenshot: async () => {
          /* no-op */
        },
        healthIntervalMs: 50,
      });
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        clock.advance(60);
      }
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.screenshotUrl).toMatch(/^\/uploads\/preview-tests\/.+\.png$/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runPreviewTest — failure modes', () => {
  it('surfaces spawn-ENOENT-style errors when the start script binary is missing', async () => {
    const failingSpawn: PreviewTestSpawnFn = () => {
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    };
    const result = await runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      spawn: failingSpawn,
      allocatePort: async () => 4300,
      clock: makeClock(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawn failed.*ENOENT/);
    expect(result.ports.allocated).toBe(4300);
  });

  it('surfaces health timeout when the dev server never returns 2xx', async () => {
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ alwaysFail: true });

    const promise = runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4310,
      healthTimeoutMs: 500,
      healthIntervalMs: 100,
    });
    // Advance past the deadline.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      clock.advance(120);
    }
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out/);
    // Teardown still happened
    expect(harness.killSignals).toContain('SIGTERM');
  });

  it('surfaces non-2xx status when the dev server returns errors only', async () => {
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ nonOkStatus: 500 });

    const promise = runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4320,
      healthTimeoutMs: 500,
      healthIntervalMs: 100,
    });
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
      clock.advance(120);
    }
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/last status: 500/);
  });

  it('surfaces port-allocation failure when no port is free', async () => {
    const result = await runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      allocatePort: async () => {
        throw new Error('Preview port pool exhausted');
      },
      clock: makeClock(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Port allocation failed.*exhausted/i);
    expect(result.ports.allocated).toBeNull();
  });

  it('always tears down the spawned process even when health times out', async () => {
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ alwaysFail: true });

    const promise = runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4330,
      healthTimeoutMs: 200,
      healthIntervalMs: 100,
    });
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      clock.advance(120);
    }
    await promise;
    // No process left behind
    expect(harness.spawned).toHaveLength(1);
    expect(harness.spawned[0].signalCode).toBe('SIGTERM');
  });

  it('short-circuits and reports code, signal, and log tail when the child exits during boot', async () => {
    const harness = makeSpawn();
    const clock = makeClock();

    // Drive the premature-exit path: the first health-poll attempt
    // simulates the dev server dying mid-boot. We push a couple of
    // stdout / stderr lines so the tail isn't empty, then emit 'exit'
    // with a real code and a null signal (the common shape when a
    // process exits via process.exit(N) rather than a signal). We also
    // set the FakeChild's exitCode so the `finally` teardown's
    // `exitCode == null && signalCode == null` guard short-circuits —
    // otherwise `waitForExit` would block on a child that has already
    // emitted its only 'exit' event.
    let firstCall = true;
    const fetch: PreviewTestHealthFetchFn = async () => {
      if (firstCall) {
        firstCall = false;
        const child = harness.spawned[0];
        child.stdout.emit('data', Buffer.from('vite v5.0.0 dev server starting\n'));
        child.stderr.emit(
          'data',
          Buffer.from('Error: listen EADDRINUSE: address already in use :::4400\n'),
        );
        child.exitCode = 1;
        child.emit('exit', 1, null);
      }
      // Subsequent loop iterations should never run because the
      // premature-exit short-circuit triggers on the next pass — but
      // we still need to satisfy the type if it did.
      throw new Error('ECONNREFUSED');
    };

    const promise = runPreviewTest({
      project: makeProject(),
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4400,
      healthTimeoutMs: 30_000,
      healthIntervalMs: 100,
    });

    // Release the awaited sleep so the loop reaches its second
    // top-of-loop `prematureExit` check.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      clock.advance(120);
    }

    const result = await promise;
    expect(result.ok).toBe(false);
    // The three fields the autonomous-dispatch card calls out — each
    // pinned by its labelled token so a future refactor of the
    // error-message format can't silently drop one.
    expect(result.error).toMatch(/code=1/);
    expect(result.error).toMatch(/signal=/);
    expect(result.error).toMatch(/Log tail:/);
    // The actual captured log content is surfaced in the tail.
    expect(result.error).toContain('vite v5.0.0 dev server starting');
    expect(result.error).toContain('EADDRINUSE');
    // Port was allocated before spawn — surfaced for the user even on failure.
    expect(result.ports.allocated).toBe(4400);
    // Because we marked the FakeChild as already exited, the finally
    // block should not have issued a redundant kill.
    expect(harness.killSignals).not.toContain('SIGTERM');
  });

  it('returns ok:true with a non-fatal error when screenshot fails', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'preview-test-'));
    try {
      const harness = makeSpawn();
      const clock = makeClock();
      const { fetch } = makeFetch({ okOnAttempt: 1 });

      const promise = runPreviewTest({
        project: makeProject(),
        uploadsDir: tmp,
        spawn: harness.spawn,
        fetch,
        clock,
        kill: harness.kill,
        allocatePort: async () => 4340,
        captureScreenshot: async () => {
          throw new Error('chromium not installed');
        },
        healthIntervalMs: 50,
      });
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        clock.advance(60);
      }
      const result = await promise;
      expect(result.ok).toBe(true);
      expect(result.screenshotUrl).toBeUndefined();
      expect(result.error).toMatch(/screenshot failed/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('runPreviewTest — directory side-effects', () => {
  it('creates the uploads/preview-tests directory on success', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'preview-test-'));
    try {
      const harness = makeSpawn();
      const clock = makeClock();
      const { fetch } = makeFetch({ okOnAttempt: 1 });

      const promise = runPreviewTest({
        project: makeProject(),
        uploadsDir: tmp,
        spawn: harness.spawn,
        fetch,
        clock,
        kill: harness.kill,
        allocatePort: async () => 4350,
        captureScreenshot: async () => {
          /* no-op */
        },
        healthIntervalMs: 50,
      });
      for (let i = 0; i < 3; i++) {
        await Promise.resolve();
        clock.advance(60);
      }
      await promise;
      expect(existsSync(path.join(tmp, 'preview-tests'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
