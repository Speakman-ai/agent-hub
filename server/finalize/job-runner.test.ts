import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'stream';
import { parseCiConfig } from './ci-config.js';
import { expandJobInstances, buildFinalizeBuiltinEnv } from './ci-config-v2.js';
import {
  runJobPhase,
  sanitizeComposeProjectName,
  readMaxParallelJobs,
  DEFAULT_MAX_PARALLEL_JOBS,
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
          on(event: 'close' | 'error', listener: (arg: never) => void) {
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
      on(event: 'close' | 'error', listener: (arg: never) => void) {
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
        on(event: 'close' | 'error', listener: (arg: never) => void) {
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
        on(event: 'close' | 'error', listener: (arg: never) => void) {
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
        on(event: 'close' | 'error', listener: (arg: never) => void) {
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

  it('passes step-level env to the spawned step (e.g. FINALIZE_WARMUP)', async () => {
    const seen: Array<Record<string, string | undefined> | undefined> = [];
    const spawnStep: SpawnStepFn = ({ step, env }) => {
      seen.push(env as Record<string, string | undefined> | undefined);
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'error', listener: (arg: never) => void) {
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
        on(event: 'close' | 'error', listener: (arg: never) => void) {
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
