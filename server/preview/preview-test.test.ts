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

  it('returns ok:false with an actionable message when preview is configured for compose mode', async () => {
    // Compose-mode dispatch is owned by `PreviewComposeRuntime` for
    // session previews; the one-shot Test endpoint doesn't yet drive a
    // transient compose lifecycle. We surface this explicitly so the
    // user knows what to do instead of seeing a confusing
    // `spawn ENOENT` from trying to run a missing startScript.
    const harness = makeSpawn();
    const result = await runPreviewTest({
      project: makeProject({
        prEnv: {
          enabled: false,
          startScript: 'npm start',
          internalPort: 3000,
          healthPath: '/',
          preview: {
            enabled: true,
            compose: {
              entryService: 'frontend',
              entryPort: 5173,
              file: 'docker-compose.yml',
            },
          },
        },
      }),
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Compose-mode previews/i);
    expect(result.error).toMatch(/<agenthub:preview>/);
    // No spawn happened — the compose dispatch short-circuits before
    // the port allocator runs.
    expect(harness.calls).toHaveLength(0);
    expect(result.ports.allocated).toBeNull();
  });

  it('returns ok:false with a clear message when the spawn cwd does not exist', async () => {
    // Regression: Node reports a missing-cwd failure as `spawn sh
    // ENOENT`, attributing the error to the binary name instead of the
    // missing directory. The pre-flight existence check turns that
    // cryptic error into an actionable message before we ever spawn.
    const harness = makeSpawn();
    const result = await runPreviewTest({
      project: makeProject(), // cwd: '/repo' — does NOT exist on disk
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      cwdExists: () => false,
      allocatePort: async () => 4123,
      kill: harness.kill,
    });
    expect(result.ok).toBe(false);
    expect(result.ports.allocated).toBe(4123); // allocation happens before the check
    expect(result.error).toMatch(/Preview cwd does not exist: \/repo/);
    expect(result.error).toMatch(/prEnv\.preview\.processes\[\]\.cwd/);
    // No spawn should have happened — the check bails before that.
    expect(harness.calls).toHaveLength(0);
    expect(result.logTail).toEqual([]);
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
        // The default project cwd (`/repo`) doesn't exist on the test
        // filesystem — the spawn seam keeps these tests hermetic. Bypass
        // the production cwd existence check so we don't bail before
        // exercising the hot path.
        cwdExists: () => true,
        uploadsDir: tmp,
        publicUrl: 'https://hub.example.com',
        spawn: (cmd, args, options) => {
          const child = harness.spawn(cmd, args, options);
          // Emit a couple of boot lines so the happy-path assertion can
          // verify `logTail` is plumbed into the success response too,
          // not just failure paths. queueMicrotask (rather than
          // setImmediate) because the test drives runPreviewTest by
          // bouncing microtasks + a fake clock — control never returns
          // to the event loop's check phase, so setImmediate would
          // never fire within the test's lifetime.
          queueMicrotask(() => {
            (child as unknown as { stdout: EventEmitter }).stdout.emit(
              'data',
              Buffer.from('vite v5.0.0 dev server running\n'),
            );
            (child as unknown as { stderr: EventEmitter }).stderr.emit(
              'data',
              Buffer.from('  ➜  Local:   http://localhost:4200/\n'),
            );
          });
          return child;
        },
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
      expect(result.logTail).toEqual(
        expect.arrayContaining([
          'vite v5.0.0 dev server running',
          '  ➜  Local:   http://localhost:4200/',
        ]),
      );
      expect(harness.calls[0]?.port).toBe('4200');
      expect(harness.calls[0]?.args).toEqual(['-c', 'npm run dev']);
      // Default cwd is now the project root, not <cwd>/client. Projects
      // that actually live in a subdirectory must set
      // prEnv.preview.processes[].cwd explicitly.
      expect(harness.calls[0]?.cwd).toBe('/repo');
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
        // The default project cwd (`/repo`) doesn't exist on the test
        // filesystem — the spawn seam keeps these tests hermetic. Bypass
        // the production cwd existence check so we don't bail before
        // exercising the hot path.
        cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
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
    // The actual captured log content is surfaced in the (inline)
    // error-string tail AND in the structured `logTail` field so the
    // UI can render the console verbatim regardless of which surface
    // it consumes.
    expect(result.error).toContain('vite v5.0.0 dev server starting');
    expect(result.error).toContain('EADDRINUSE');
    expect(result.logTail).toEqual(
      expect.arrayContaining([
        'vite v5.0.0 dev server starting',
        'Error: listen EADDRINUSE: address already in use :::4400',
      ]),
    );
    // Port was allocated before spawn — surfaced for the user even on failure.
    expect(result.ports.allocated).toBe(4400);
    // Because we marked the FakeChild as already exited, the finally
    // block should not have issued a redundant kill.
    expect(harness.killSignals).not.toContain('SIGTERM');
  });

  it('defaults the health-check timeout to 120s (parity with PreviewRuntime)', async () => {
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ alwaysFail: true });

    const promise = runPreviewTest({
      project: makeProject(),
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
      uploadsDir: '/tmp/uploads',
      spawn: harness.spawn,
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4360,
      // Intentionally omit healthTimeoutMs — exercise the default.
      healthIntervalMs: 1_000,
    });

    // Advance well past the legacy 30s ceiling but stop short of the
    // new 120s default. If the default ever regresses to 30s the loop
    // would have bailed and the assertion below would observe a
    // truthy `done` here instead of still-pending.
    for (let i = 0; i < 70; i++) {
      await Promise.resolve();
      clock.advance(1_000);
    }
    let done = false;
    promise.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);

    // Now push past 120s to let the loop finish naturally.
    for (let i = 0; i < 70; i++) {
      await Promise.resolve();
      clock.advance(1_000);
    }
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/timed out after 120000ms/);
  });

  it('bails immediately on async spawn error without waiting the full timeout', async () => {
    const harness = makeSpawn();
    const clock = makeClock();
    const { fetch } = makeFetch({ alwaysFail: true });

    const promise = runPreviewTest({
      project: makeProject(),
      // Bypass the production cwd existence check — see note in the tmp tests above.
      cwdExists: () => true,
      uploadsDir: '/tmp/uploads',
      spawn: (cmd, args, options) => {
        const child = harness.spawn(cmd, args, options);
        // Fire an async 'error' event right after the synchronous
        // spawn returns — emulates Node's behaviour when `sh` itself
        // can't be located or when `options.cwd` doesn't exist.
        // queueMicrotask, not setImmediate (see happy-path comment).
        queueMicrotask(() => {
          (child as unknown as EventEmitter).emit('error', new Error('spawn sh ENOENT'));
        });
        return child;
      },
      fetch,
      clock,
      kill: harness.kill,
      allocatePort: async () => 4370,
      healthTimeoutMs: 120_000,
      healthIntervalMs: 500,
    });

    // Only need a couple of ticks for the 'error' event + first poll
    // iteration. If the bail-out is wired correctly the promise
    // resolves long before the 120s deadline.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
      clock.advance(600);
    }
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Spawn error: spawn sh ENOENT/);
    // We bailed via the async-error short-circuit, not via the 120s
    // timeout — clock-elapsed should be measured in seconds, not minutes.
    expect(result.durationMs).toBeLessThan(10_000);
    // logTail is present (empty here because the spawn died before any
    // stdout/stderr was emitted).
    expect(result.logTail).toEqual([]);
  });

  it('returns ok:true with a non-fatal error when screenshot fails', async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'preview-test-'));
    try {
      const harness = makeSpawn();
      const clock = makeClock();
      const { fetch } = makeFetch({ okOnAttempt: 1 });

      const promise = runPreviewTest({
        project: makeProject(),
        // The default project cwd (`/repo`) doesn't exist on the test
        // filesystem — the spawn seam keeps these tests hermetic. Bypass
        // the production cwd existence check so we don't bail before
        // exercising the hot path.
        cwdExists: () => true,
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
        // The default project cwd (`/repo`) doesn't exist on the test
        // filesystem — the spawn seam keeps these tests hermetic. Bypass
        // the production cwd existence check so we don't bail before
        // exercising the hot path.
        cwdExists: () => true,
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
