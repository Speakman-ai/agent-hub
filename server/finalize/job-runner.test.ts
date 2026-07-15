import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { parseCiConfig } from './ci-config.js';
import { expandJobInstances, buildFinalizeBuiltinEnv } from './ci-config-v2.js';
import {
  runJobPhase,
  sanitizeComposeProjectName,
  readMaxParallelJobs,
  DEFAULT_MAX_PARALLEL_JOBS,
  DEFAULT_MIN_ACQUIRE_TIMEOUT_MS,
  minAcquireTimeoutMs,
} from './job-runner.js';
import { createLocalRunnerBackend } from './runner-backend-local.js';
import type { SpawnedStep, SpawnStepFn, StepRunnerDeps } from './step-runner.js';

vi.mock('./job-container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./job-container.js')>();
  let execRuns: ((run: string) => void) | undefined;
  return {
    ...actual,
    startJobContainer: vi.fn().mockResolvedValue(undefined),
    stopJobContainer: vi.fn().mockResolvedValue(undefined),
    createJobScopedSpawnStep: vi.fn(() => {
      return ({ step }: { step: { run: string } }) => {
        execRuns?.(step.run);
        const child: SpawnedStep = {
          stdout: null,
          stderr: null,
          on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
            if (event === 'close')
              queueMicrotask(() => (listener as (code: number | null) => void)(0));
            return child;
          },
          kill: vi.fn(() => true),
        };
        return child;
      };
    }),
    __setExecRuns: (fn: (run: string) => void) => {
      execRuns = fn;
    },
  };
});

function makeFakeSpawnStep(onRun?: (run: string) => void): SpawnStepFn {
  return ({ step }) => {
    onRun?.(step.run);
    const child: SpawnedStep = {
      stdout: null,
      stderr: null,
      on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
        if (event === 'close') queueMicrotask(() => (listener as (code: number | null) => void)(0));
        return child;
      },
      kill: vi.fn(() => true),
    };
    return child;
  };
}

describe('readMaxParallelJobs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honors an explicit FINALIZE_MAX_PARALLEL_JOBS regardless of backend', () => {
    vi.stubEnv('FINALIZE_MAX_PARALLEL_JOBS', '6');
    vi.stubEnv('FINALIZE_RUNNER_BACKEND', 'remote');
    expect(readMaxParallelJobs()).toBe(6);

    vi.stubEnv('FINALIZE_RUNNER_BACKEND', 'local');
    expect(readMaxParallelJobs()).toBe(6);
  });

  it('is uncapped on the remote backend (queue + fleet manage concurrency)', () => {
    vi.stubEnv('FINALIZE_MAX_PARALLEL_JOBS', '');
    vi.stubEnv('FINALIZE_RUNNER_BACKEND', 'remote');
    expect(readMaxParallelJobs()).toBe(Number.POSITIVE_INFINITY);
  });

  it('uses the conservative host default on the local backend (unset/local)', () => {
    vi.stubEnv('FINALIZE_MAX_PARALLEL_JOBS', '');

    vi.stubEnv('FINALIZE_RUNNER_BACKEND', '');
    expect(readMaxParallelJobs()).toBe(DEFAULT_MAX_PARALLEL_JOBS);

    vi.stubEnv('FINALIZE_RUNNER_BACKEND', 'local');
    expect(readMaxParallelJobs()).toBe(DEFAULT_MAX_PARALLEL_JOBS);
  });

  it('ignores an invalid FINALIZE_MAX_PARALLEL_JOBS and uses the backend default', () => {
    vi.stubEnv('FINALIZE_MAX_PARALLEL_JOBS', '0');
    vi.stubEnv('FINALIZE_RUNNER_BACKEND', 'local');
    expect(readMaxParallelJobs()).toBe(DEFAULT_MAX_PARALLEL_JOBS);
  });
});

describe('minAcquireTimeoutMs', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to DEFAULT_MIN_ACQUIRE_TIMEOUT_MS when unset', () => {
    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '');
    expect(minAcquireTimeoutMs()).toBe(DEFAULT_MIN_ACQUIRE_TIMEOUT_MS);
  });

  it('honors a valid override at or above the 1s minimum', () => {
    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '60000');
    expect(minAcquireTimeoutMs()).toBe(60_000);

    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '1000');
    expect(minAcquireTimeoutMs()).toBe(1_000);
  });

  it('coerces a sub-1s positive override UP to the 1s hard minimum', () => {
    // 1..999 are honored as a real (too-low) override and clamped to 1000 — the
    // safety floor must always stay above the sub-second livelock window.
    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '500');
    expect(minAcquireTimeoutMs()).toBe(1_000);

    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '1');
    expect(minAcquireTimeoutMs()).toBe(1_000);
  });

  it('treats 0 / negative / garbage as "no override" and falls back to the default', () => {
    // Deliberately asymmetric with 1..999: 0/negative are far more likely an
    // attempt to DISABLE the floor (re-introducing the livelock) than a request
    // for 1s, so they resolve to the safe 30s default rather than the 1s minimum.
    for (const bad of ['0', '-1', '-1000', 'abc', 'NaN', 'off']) {
      vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', bad);
      expect(minAcquireTimeoutMs()).toBe(DEFAULT_MIN_ACQUIRE_TIMEOUT_MS);
    }
  });

  it('parses a leading-integer override (parseInt semantics) and clamps it', () => {
    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '45000ms');
    expect(minAcquireTimeoutMs()).toBe(45_000);

    vi.stubEnv('FINALIZE_MIN_ACQUIRE_TIMEOUT_MS', '120abc');
    expect(minAcquireTimeoutMs()).toBe(1_000);
  });
});

describe('job-runner', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sanitizeComposeProjectName produces lowercase unique shard prefixes', () => {
    expect(sanitizeComposeProjectName('run-1', 'e2e', 'Profiles & Tasks')).toMatch(
      /^finalize-run-1-e2e-profiles-tasks$/,
    );
    expect(sanitizeComposeProjectName('run-1', 'e2e', 'Core_Workflows')).toBe(
      'finalize-run-1-e2e-core_workflows',
    );
  });

  it('smoke: single container job runs docker version step', async () => {
    const spawnCalls: string[] = [];
    const spawnStep = vi.fn(makeFakeSpawnStep((run) => spawnCalls.push(run)));

    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  smoke:
    runs-on: host
    steps:
      - run: docker version
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const deps: StepRunnerDeps = {
      stmts: {
        getFinalizeRun: { get: vi.fn() },
        updateFinalizeRunPhase: { run: vi.fn() },
        updateFinalizeRunActiveSeconds: { run: vi.fn() },
        failFinalizeRun: { run: vi.fn() },
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn() },
        upsertFinalizeRunStep: { run: vi.fn() },
        listFinalizeRunStepsForRun: { all: vi.fn(() => []) },
        upsertFinalizeRunJob: { run: vi.fn() },
        listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
      } as unknown as StepRunnerDeps['stmts'],
      broadcast: vi.fn(),
      spawnStep,
    };

    const result = await runJobPhase(deps, {
      runId: 'smoke-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(spawnCalls).toEqual(['docker version']);
  });

  const makeDeps = (spawnStep: SpawnStepFn): StepRunnerDeps => ({
    stmts: {
      getFinalizeRun: { get: vi.fn() },
      updateFinalizeRunPhase: { run: vi.fn() },
      updateFinalizeRunActiveSeconds: { run: vi.fn() },
      failFinalizeRun: { run: vi.fn() },
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
      upsertFinalizeRunStep: { run: vi.fn() },
      listFinalizeRunStepsForRun: { all: vi.fn(() => []) },
      upsertFinalizeRunJob: { run: vi.fn() },
      listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
    } as unknown as StepRunnerDeps['stmts'],
    broadcast: vi.fn(),
    spawnStep,
  });

  const WARMUP_CONFIG = `
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    warmup: true
    steps:
      - run: warmup-cmd
  e2e:
    runs-on: host
    matrix:
      include:
        - group: A
          specs: a.cy.ts
        - group: B
          specs: b.cy.ts
    steps:
      - run: test-cmd \${FINALIZE_MATRIX_SPECS}
`;

  it('routes a container job through the injected RunnerBackend (scheduler is backend-agnostic)', async () => {
    const order: string[] = [];
    const acquired: Array<{ jobId: string; image: string }> = [];
    let released = 0;
    const fakeBackend = {
      kind: 'fake',
      acquire: async (spec: { jobId: string; image: string }) => {
        acquired.push({ jobId: spec.jobId, image: spec.image });
        return {
          spawnStep: makeFakeSpawnStep((run) => order.push(run)),
          release: async () => {
            released += 1;
          },
        };
      },
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: e2e-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const deps = { ...makeDeps(vi.fn()), runnerBackend: fakeBackend } as StepRunnerDeps;
    const result = await runJobPhase(deps, {
      runId: 'backend-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    // Steps ran through the backend's lease, not local DinD; teardown happened.
    expect(acquired).toHaveLength(1);
    expect(acquired[0].jobId).toBe('e2e');
    expect(acquired[0].image).toBeTruthy();
    expect(order).toEqual(['e2e-cmd']);
    expect(released).toBe(1);
  });

  it('passes the remaining run budget as the runner acquire timeout cap', async () => {
    const acquired: Array<{ acquireTimeoutMs?: number }> = [];
    const fakeBackend = {
      kind: 'fake',
      acquire: async (spec: { acquireTimeoutMs?: number }) => {
        acquired.push({ acquireTimeoutMs: spec.acquireTimeoutMs });
        return {
          spawnStep: makeFakeSpawnStep(),
          release: async () => {},
        };
      },
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
timeout_minutes: 3
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: e2e-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const deps = { ...makeDeps(vi.fn()), runnerBackend: fakeBackend } as StepRunnerDeps;
    const result = await runJobPhase(deps, {
      runId: 'budget-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(acquired).toHaveLength(1);
    expect(acquired[0].acquireTimeoutMs).toBeGreaterThan(0);
    expect(acquired[0].acquireTimeoutMs).toBeLessThanOrEqual(3 * 60_000);
    // Never a sub-floor (1ms) window — the fleet must have a viable chance to
    // scale up and claim the job (card #1243).
    expect(acquired[0].acquireTimeoutMs).toBeGreaterThanOrEqual(DEFAULT_MIN_ACQUIRE_TIMEOUT_MS);
  });

  it('does not attempt to acquire a runner once the run budget is exhausted (card #1243)', async () => {
    const acquired: Array<{ acquireTimeoutMs?: number }> = [];
    const fakeBackend = {
      kind: 'fake',
      acquire: async (spec: { acquireTimeoutMs?: number }) => {
        acquired.push({ acquireTimeoutMs: spec.acquireTimeoutMs });
        return { spawnStep: makeFakeSpawnStep(), release: async () => {} };
      },
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
timeout_minutes: 1
jobs:
  e2e:
    runs-on: ubuntu-24.04
    steps:
      - run: e2e-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    // Clock: the FIRST now() call stamps budgetStartedAt; every later call jumps
    // far past the 1-minute budget, so by the time the job evaluates its
    // remaining budget the run is provably out of time. (Robust to the exact
    // number of now() calls — only the first-call ordering matters.)
    const base = 1_000_000;
    let firstCall = true;
    const now = () => {
      if (firstCall) {
        firstCall = false;
        return base;
      }
      return base + 10 * 60_000;
    };

    const deps = { ...makeDeps(vi.fn()), runnerBackend: fakeBackend, now } as StepRunnerDeps;
    const result = await runJobPhase(deps, {
      runId: 'exhausted-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    // No acquire was attempted — a sub-floor window would only instant-fail and
    // livelock the per-instance + orchestrator retry loops.
    expect(acquired).toHaveLength(0);
    // Terminal as a distinct, non-retryable budget_exhausted reason (CI-class).
    expect(result.status).toBe('infra_error');
    expect(result.failureReason).toBe('budget_exhausted');
    expect(result.infraErrorDetail).toMatch(/budget exhausted/i);
  });

  it('runs warmup job to completion before any fan-out shard', async () => {
    const order: string[] = [];
    const spawnStep = vi.fn(makeFakeSpawnStep((run) => order.push(run)));
    const parsed = parseCiConfig(WARMUP_CONFIG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(spawnStep), {
      runId: 'warm-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    // Warmup ran first; both fan-out shards ran after it.
    expect(order[0]).toBe('warmup-cmd');
    expect(order).toContain('test-cmd a.cy.ts');
    expect(order).toContain('test-cmd b.cy.ts');
    expect(order.indexOf('warmup-cmd')).toBeLessThan(order.indexOf('test-cmd a.cy.ts'));
    expect(order.indexOf('warmup-cmd')).toBeLessThan(order.indexOf('test-cmd b.cy.ts'));
  });

  it('skips fan-out shards when the warmup job fails', async () => {
    const order: string[] = [];
    // warmup-cmd exits non-zero; everything else would exit 0.
    const spawnStep: SpawnStepFn = ({ step }) => {
      order.push(step.run);
      const code = step.run === 'warmup-cmd' ? 1 : 0;
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close')
            queueMicrotask(() => (listener as (c: number | null) => void)(code));
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };
    const parsed = parseCiConfig(WARMUP_CONFIG);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'warm-fail-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).not.toBe('success');
    // The fan-out shards never ran — only the warmup step was spawned.
    expect(order).toEqual(['warmup-cmd']);
  });

  it('a genuine shard failure wins over a `context canceled` collateral shard', async () => {
    // Shard A genuinely fails an assertion (exit 1). Shard B is cancelled
    // mid-run — the inner dockerd dies and the CLI prints the Go context error
    // (exit 1). Shard B must be reclassified `runner_cancelled` (infra) and the
    // REAL red (shard A's step_failed) must be what the run surfaces, so the fix
    // loop chases the genuine failure, not the collateral.
    const MATRIX = `
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: host
    matrix:
      include:
        - group: A
          specs: a.cy.ts
        - group: B
          specs: b.cy.ts
    steps:
      - run: test-cmd \${FINALIZE_MATRIX_SPECS}
`;
    const spawnStep: SpawnStepFn = ({ step }) => {
      const isCollateral = step.run.includes('b.cy.ts');
      const stderr = new Readable({ read() {} });
      const stdout = new Readable({ read() {} });
      const child: SpawnedStep = {
        stdout,
        stderr,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close') {
            queueMicrotask(() => {
              if (isCollateral) {
                stderr.push(
                  'error during connect: Get "http://docker.sock/info": context canceled\n',
                );
              } else {
                stdout.push('AssertionError: expected 200 but got 500\n');
              }
              queueMicrotask(() => (listener as (c: number | null) => void)(1));
            });
          }
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };

    const parsed = parseCiConfig(MATRIX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'collateral-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    // The genuine CI failure is what the run reports — NOT the infra collateral.
    expect(result.status).toBe('failure');
    expect(result.failedStep?.matrixKey).toContain('A');
  });

  it('collects every failed job into failedSteps when several go red (waits for all)', async () => {
    // Two independent jobs both genuinely fail in the same round. The
    // scheduler waits for both before returning, so the round must surface
    // BOTH reds in `failedSteps` (not just the primary) — that is what lets
    // the orchestrator dispatch a single fix turn covering every failure.
    const MATRIX = `
version: 2
on: [finalize]
jobs:
  backend:
    runs-on: host
    steps:
      - run: backend-test
  frontend:
    runs-on: host
    steps:
      - run: frontend-test
`;
    const spawnStep: SpawnStepFn = ({ step }) => {
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const child: SpawnedStep = {
        stdout,
        stderr,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close') {
            queueMicrotask(() => {
              if (step.run.includes('backend')) {
                stdout.push('FAIL server/foo.test.ts\n');
              } else {
                stdout.push('error TS2304: Cannot find name bar\n');
              }
              queueMicrotask(() => (listener as (c: number | null) => void)(1));
            });
          }
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };

    const parsed = parseCiConfig(MATRIX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'multi-fail-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('failure');
    expect(result.failedSteps).toBeDefined();
    expect(result.failedSteps).toHaveLength(2);
    const jobIds = (result.failedSteps ?? []).map((s) => s.jobId).sort();
    expect(jobIds).toEqual(['backend', 'frontend']);
  });

  it('a failing shard does NOT write the run-level terminal while siblings run (regression: #1122)', async () => {
    // THE BUG: with parallel matrix shards, the FIRST shard to fail used to call
    // `failFinalizeRun('failed', 'step_failed', runId)` from inside its own
    // `runStepsSequence`. That stamps the shared `finalize_runs` row terminal
    // (status='failed' + ended_at) the moment one shard goes red — while sibling
    // shards are STILL executing. The run then looks finished and the session
    // flips to "waiting for user input" mid-run, even though the rest of the
    // tests are still running (the repeatedly-reported symptom).
    //
    // THE CONTRACT: a shard must NEVER write the run-level terminal. It records
    // its per-job state and returns its failure-shaped result; the orchestrator
    // writes the single authoritative run-level terminal AFTER aggregating every
    // shard (mirroring how `infra_error` already defers to the orchestrator).
    const MATRIX = `
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: host
    matrix:
      include:
        - group: Fails_Fast
          specs: a.cy.ts
        - group: Slow_Green
          specs: b.cy.ts
    steps:
      - run: test-cmd \${FINALIZE_MATRIX_SPECS}
`;
    // Shard A (a.cy.ts) fails immediately with exit 1; shard B (b.cy.ts) takes a
    // few macrotask hops before exiting 0 — so when A goes red, B is provably
    // still in flight. This is the exact interleaving that used to mark the run
    // terminal prematurely.
    const spawnStep: SpawnStepFn = ({ step }) => {
      const isFastFail = step.run.includes('a.cy.ts');
      const stdout = new Readable({ read() {} });
      const stderr = new Readable({ read() {} });
      const child: SpawnedStep = {
        stdout,
        stderr,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close') {
            if (isFastFail) {
              queueMicrotask(() => {
                stdout.push('AssertionError: expected 200 but got 500\n');
                queueMicrotask(() => (listener as (c: number | null) => void)(1));
              });
            } else {
              // Defer B's close across several timer hops so it is still
              // running at the instant A fails.
              setTimeout(() => (listener as (c: number | null) => void)(0), 5);
            }
          }
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };

    const parsed = parseCiConfig(MATRIX);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const deps = makeDeps(vi.fn(spawnStep));
    const result = await runJobPhase(deps, {
      runId: 'defer-terminal-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    // 1) THE REGRESSION ASSERTION: no shard wrote the run-level terminal. The
    //    orchestrator (not exercised here) owns that write after aggregation.
    expect(deps.stmts.failFinalizeRun.run).not.toHaveBeenCalled();

    // 2) The orchestrator still sees the red — aggregation is unaffected.
    expect(result.status).toBe('failure');
    expect(result.failedStep?.matrixKey).toContain('Fails_Fast');

    // 3) Per-job state IS still persisted: the failing shard 'failed', the
    //    sibling 'passed'. (Job-level rows are owned by the job runner; only the
    //    RUN-level terminal moved to the orchestrator.)
    const jobUpserts = (deps.stmts.upsertFinalizeRunJob.run as unknown as ReturnType<typeof vi.fn>)
      .mock.calls;
    const finalJobStates = new Map<string, string>();
    for (const call of jobUpserts) {
      // upsertFinalizeRunJob(runId, jobId, matrixKey, state, ...)
      const matrixKey = call[2] as string;
      const state = call[3] as string;
      finalJobStates.set(matrixKey, state);
    }
    const states = [...finalJobStates.entries()];
    expect(states.some(([key, state]) => key.includes('Fails_Fast') && state === 'failed')).toBe(
      true,
    );
    expect(states.some(([key, state]) => key.includes('Slow_Green') && state === 'passed')).toBe(
      true,
    );
  });

  it('passes step-level env to the spawned step (e.g. FINALIZE_WARMUP)', async () => {
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const spawnStep: SpawnStepFn = ({ step, env }) => {
      seen.push(env as Record<string, string | undefined> | undefined);
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close') queueMicrotask(() => (listener as (c: number | null) => void)(0));
          return child;
        },
        kill: vi.fn(() => true),
      };
      void step;
      return child;
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    steps:
      - name: warm
        env:
          FINALIZE_WARMUP: "1"
        run: prepare-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'stepenv-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(seen[0]?.FINALIZE_WARMUP).toBe('1');
  });

  it('needs: a dependent job waits for its prerequisite while independent jobs run free', async () => {
    const order: string[] = [];
    const spawnStep = vi.fn(makeFakeSpawnStep((run) => order.push(run)));
    // backend has no needs (runs immediately); e2e needs prepare.
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    steps:
      - run: prepare-cmd
  backend:
    runs-on: host
    steps:
      - run: backend-cmd
  e2e:
    runs-on: host
    needs: [prepare]
    steps:
      - run: e2e-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(spawnStep), {
      runId: 'needs-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    // e2e ran only after prepare; backend was not gated by prepare.
    expect(order).toContain('prepare-cmd');
    expect(order).toContain('backend-cmd');
    expect(order.indexOf('prepare-cmd')).toBeLessThan(order.indexOf('e2e-cmd'));
  });

  it('needs: skips a dependent job when its prerequisite fails', async () => {
    const order: string[] = [];
    const spawnStep: SpawnStepFn = ({ step }) => {
      order.push(step.run);
      const code = step.run === 'prepare-cmd' ? 1 : 0;
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close')
            queueMicrotask(() => (listener as (c: number | null) => void)(code));
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  prepare:
    runs-on: host
    # retries: 0 keeps this skip-cascade test focused on dependency semantics —
    # the failing prepare shard should NOT be re-run by the flaky-test retry
    # default here (that behavior is covered in job-runner-failure-retry.test.ts).
    retries: 0
    steps:
      - run: prepare-cmd
  e2e:
    runs-on: host
    needs: [prepare]
    steps:
      - run: e2e-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'needs-fail-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).not.toBe('success');
    expect(order).toEqual(['prepare-cmd']); // e2e never ran
  });

  it('surfaces a shard that failed then passed on a config-retry as a recovered flake', async () => {
    // Shard fails its test the FIRST time (exit 1), passes on the same-commit
    // retry (exit 0). The phase is green, but the recovery must be reported in
    // `flakeRecoveredInstances` so the orchestrator's flake gate can withhold
    // auto-push instead of laundering the flake into a clean merge.
    let attempts = 0;
    const spawnStep: SpawnStepFn = ({ step }) => {
      const code = step.run === 'flaky-cmd' ? (attempts++ === 0 ? 1 : 0) : 0;
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close')
            queueMicrotask(() => (listener as (c: number | null) => void)(code));
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  server:
    runs-on: host
    retries: 2
    steps:
      - run: flaky-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(vi.fn(spawnStep)), {
      runId: 'flake-recover-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success'); // green after the retry
    expect(attempts).toBe(2); // initial fail + one rerun
    expect(result.flakeRecoveredInstances).toEqual([
      { jobId: 'server', matrixKey: '', failureCount: 1 },
    ]);
  });

  it('does not report flakeRecoveredInstances when a shard passes first try', async () => {
    const spawnStep = vi.fn(makeFakeSpawnStep(() => {}));
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  server:
    runs-on: host
    steps:
      - run: clean-cmd
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(spawnStep), {
      runId: 'clean-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(result.flakeRecoveredInstances).toBeUndefined();
  });

  it('persists every planned step as queued up front (pending display)', async () => {
    const spawnStep = vi.fn(makeFakeSpawnStep(() => {}));
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  alpha:
    runs-on: host
    steps:
      - run: echo one
      - run: echo two
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const upsertStep = vi.fn();
    const deps: StepRunnerDeps = {
      stmts: {
        getFinalizeRun: { get: vi.fn() },
        updateFinalizeRunPhase: { run: vi.fn() },
        updateFinalizeRunActiveSeconds: { run: vi.fn() },
        failFinalizeRun: { run: vi.fn() },
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn() },
        upsertFinalizeRunStep: { run: upsertStep },
        listFinalizeRunStepsForRun: { all: vi.fn(() => []) },
        upsertFinalizeRunJob: { run: vi.fn() },
        listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
      } as unknown as StepRunnerDeps['stmts'],
      broadcast: vi.fn(),
      spawnStep,
    };

    await runJobPhase(deps, {
      runId: 'queue-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    // upsertFinalizeRunStep.run(runId, stepIndex, name, state, ...): state is arg[3].
    // Both planned steps (indices 1 and 2) must get an early `queued` row so the
    // checks panel can show them as pending before their job starts running.
    const queuedIndices = upsertStep.mock.calls.filter((c) => c[3] === 'queued').map((c) => c[1]);
    expect(queuedIndices).toEqual(expect.arrayContaining([1, 2]));
  });

  it('expandJobInstances assigns FINALIZE_MATRIX_* env vars', () => {
    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    matrix:
      include:
        - group: A
          specs: x.cy.ts
    steps:
      - run: echo
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;
    const [instance] = expandJobInstances(
      parsed.config,
      buildFinalizeBuiltinEnv({ branch: 'b', headSha: 's' }),
    );
    expect(instance.env.FINALIZE_MATRIX_SPECS).toBe('x.cy.ts');
    expect(instance.env.FINALIZE_JOB_KEY).toBe('e2e');
  });

  it('dind ubuntu job: starts one container and execs each step', async () => {
    const jobContainer = await import('./job-container.js');
    const { startJobContainer, stopJobContainer, createJobScopedSpawnStep } = jobContainer;
    const execRuns: string[] = [];
    (jobContainer as { __setExecRuns?: (fn: (run: string) => void) => void }).__setExecRuns?.(
      (run) => execRuns.push(run),
    );

    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  checks:
    runs-on: ubuntu-24.04
    steps:
      - name: step one
        run: echo one
      - name: step two
        run: echo two
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    // Hermetic backend selection. `runJobInstance` picks the backend via
    // `deps.runnerBackend ?? resolveRunnerBackend()`, and resolveRunnerBackend
    // reads (and caches) FINALIZE_RUNNER_BACKEND from the ambient env. On the
    // Finalize fleet the job container inherits FINALIZE_RUNNER_BACKEND=remote
    // from the Hub, so without this injection the test would pick the REMOTE
    // backend, whose acquire() tries to reach the control plane and throws →
    // `infra_error` instead of `success`. Inject the local backend (which still
    // routes through the mocked job-container.js) and pin dind mode so the test
    // is independent of the environment it runs in.
    vi.stubEnv('FINALIZE_RUNNER_DOCKER_MODE', 'dind');
    const deps: StepRunnerDeps = {
      stmts: {
        getFinalizeRun: { get: vi.fn() },
        updateFinalizeRunPhase: { run: vi.fn() },
        updateFinalizeRunActiveSeconds: { run: vi.fn() },
        failFinalizeRun: { run: vi.fn() },
        addMessage: { run: vi.fn() },
        touchSession: { run: vi.fn() },
        getMessageById: { get: vi.fn() },
        upsertFinalizeRunStep: { run: vi.fn() },
        listFinalizeRunStepsForRun: { all: vi.fn(() => []) },
        upsertFinalizeRunJob: { run: vi.fn() },
        listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
      } as unknown as StepRunnerDeps['stmts'],
      broadcast: vi.fn(),
      // Inject the local (DinD job-container) backend explicitly so the test is
      // hermetic. Without this, runJobPhase falls back to resolveRunnerBackend(),
      // which returns the REMOTE backend whenever FINALIZE_RUNNER_BACKEND=remote
      // is set in the environment (as it is inside the Finalize CI runner). The
      // remote backend `git bundle`s the worktree, so the fake '/tmp/wt' path
      // below would fail with infra_error. The local backend uses the mocked
      // startJobContainer/createJobScopedSpawnStep/stopJobContainer this test
      // already asserts against.
      runnerBackend: createLocalRunnerBackend(),
    };

    const result = await runJobPhase(deps, {
      runId: 'dind-run',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'main',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(startJobContainer).toHaveBeenCalledTimes(1);
    expect(stopJobContainer).toHaveBeenCalledTimes(1);
    expect(createJobScopedSpawnStep).toHaveBeenCalledTimes(1);
    expect(execRuns).toEqual(['echo one', 'echo two']);
  });
});
