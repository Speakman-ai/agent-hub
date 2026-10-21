import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCiConfig } from './ci-config.js';
import { runJobPhase } from './job-runner.js';
import { cacheObjectPrefix, type CacheStore } from './ci-cache.js';
import type { CiConfig } from './ci-config-jobs.js';
import type { SpawnedStep, SpawnStepFn, StepRunnerDeps } from './step-runner.js';
import { createFinalizeRunSignal } from './run-abort-registry.js';

interface SpawnRecord {
  name: string;
  run: string;
  env: Record<string, string>;
  deadlineMs?: number;
}

/** Exit code per step, or 'lost' to simulate the runner dying mid-step. */
type Outcome = number | 'lost';

function recordingSpawn(
  records: SpawnRecord[],
  outcomeFor: (run: string, name: string) => Outcome,
): SpawnStepFn {
  return ({ step, env, deadlineMs }) => {
    const name = step.name.split(' / ').pop() ?? step.name;
    records.push({
      name,
      run: step.run,
      env: { ...((env ?? {}) as Record<string, string>), ...(step.env ?? {}) },
      deadlineMs,
    });
    const outcome = outcomeFor(step.run, name);
    const child: SpawnedStep = {
      stdout: null,
      stderr: null,
      on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
        if (event === 'close' && outcome !== 'lost') {
          queueMicrotask(() => (listener as (c: number | null) => void)(outcome));
        }
        if (event === 'error' && outcome === 'lost') {
          queueMicrotask(() => (listener as (e: Error) => void)(new Error('runner-agent lost')));
        }
        return child;
      },
      kill: vi.fn(() => true),
    };
    return child;
  };
}

function makeDeps(spawnStep: SpawnStepFn) {
  const upsertStep = vi.fn();
  const release = vi.fn(async () => {});
  const deps = {
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
    runnerBackend: {
      kind: 'remote',
      acquire: async () => ({ spawnStep, release }),
    },
  } as unknown as StepRunnerDeps;
  return { deps, upsertStep, release };
}

function fakeStore(objects: Record<string, number> = {}): CacheStore {
  return {
    exists: vi.fn(async (k: string) => k in objects),
    newestWithPrefix: vi.fn(async () => null),
    presignGet: vi.fn(async (k: string) => `https://s3.example/get/${k}?sig=secret`),
    presignPut: vi.fn(async (k: string) => `https://s3.example/put/${k}?sig=secret`),
  };
}

function config(yaml: string): CiConfig {
  const parsed = parseCiConfig(yaml);
  if (!parsed.ok || parsed.config.version !== 2) throw new Error('bad fixture');
  return parsed.config;
}

const CACHED_JOB = `
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: ubuntu-24.04
    cache:
      - key: img-\${FINALIZE_HEAD_SHA}
        path: e2e-images
    steps:
      - name: Tests
        run: ./run_e2e_ci.sh
`;

const opts = (store: CacheStore | null) => ({
  runId: 'run-1',
  config: config(CACHED_JOB),
  worktreePath: '/tmp/wt',
  sessionId: 'sess',
  branch: 'main',
  headSha: 'abc123',
  orgId: 'org',
  projectId: 'proj',
  cacheStore: store,
});

describe('runJobPhase with job cache entries', () => {
  beforeEach(() => {
    // Skip the repo-visibility probe for container jobs.
    vi.stubEnv('FINALIZE_RUNNER_RESOURCE_PROFILE', 'unconstrained');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('wraps the job in restore and save steps and passes presigned URLs via env only', async () => {
    const records: SpawnRecord[] = [];
    const store = fakeStore();
    const { deps } = makeDeps(recordingSpawn(records, () => 0));

    const result = await runJobPhase(deps, opts(store));

    expect(result.status).toBe('success');
    expect(records.map((r) => r.name)).toEqual([
      'Restore cache (e2e-images)',
      'Tests',
      'Save cache (e2e-images)',
    ]);
    const [restore, tests, save] = records;
    expect(restore.env.AH_CACHE_STATUS).toBe('miss');
    expect(tests.env.AH_CACHE_STATUS).toBeUndefined();
    expect(save.env).toMatchObject({
      AH_CACHE_STATUS: 'save',
      AH_CACHE_KEY: 'img-abc123',
      AH_CACHE_URL: `https://s3.example/put/${cacheObjectPrefix('org', 'proj')}img-abc123?sig=secret`,
    });
    for (const r of records) expect(r.run).not.toContain('sig=secret');
    expect(result.stepResults).toHaveLength(3);
    for (const s of result.stepResults) expect(s.run).not.toContain('sig=secret');
  });

  it('reports runner startup phases and cache restore time for the job', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(recordingSpawn(records, () => 0));
    const spawnStep = recordingSpawn(records, () => 0);
    deps.runnerBackend = {
      kind: 'remote',
      acquire: async () => ({
        spawnStep,
        release: async () => {},
        startup: Promise.resolve({ queue_wait: 40_000, container_start: 7_000 }),
      }),
    };
    const samples: Array<{ jobId: string; backend: string; phases: Record<string, number> }> = [];

    await runJobPhase(deps, {
      ...opts(fakeStore()),
      onJobStartup: (s) => samples.push(s as (typeof samples)[number]),
    });

    const ready = samples.find((s) => 'total' in s.phases);
    expect(ready).toMatchObject({
      jobId: 'e2e',
      backend: 'remote',
      phases: { queue_wait: 40_000, container_start: 7_000 },
    });
    expect(ready!.phases.total).toBeGreaterThanOrEqual(0);
    const restore = samples.find((s) => 'cache_restore' in s.phases);
    expect(restore).toMatchObject({ jobId: 'e2e', backend: 'remote' });
    expect(samples).toHaveLength(2);
  });

  it('times cache restore from runner readiness, not from when the restore queued behind bring-up', async () => {
    let clock = 1_000_000;
    let readyStartup!: (t: { container_start: number }) => void;
    let finishRestore!: () => void;
    let restoreSpawned = false;
    const restoreDone = new Promise<void>((r) => (finishRestore = r));
    const spawnStep: SpawnStepFn = ({ step }) => {
      const isRestore = step.name.includes('Restore cache');
      if (isRestore) restoreSpawned = true;
      const child: SpawnedStep = {
        stdout: null,
        stderr: null,
        on(event: 'close' | 'exit' | 'error', listener: (arg: never) => void) {
          if (event === 'close') {
            const close = () => (listener as (c: number | null) => void)(0);
            if (isRestore) void restoreDone.then(close);
            else queueMicrotask(close);
          }
          return child;
        },
        kill: vi.fn(() => true),
      };
      return child;
    };
    const { deps } = makeDeps(spawnStep);
    (deps as { now?: () => number }).now = () => clock;
    deps.runnerBackend = {
      kind: 'remote',
      acquire: async () => ({
        spawnStep,
        release: async () => {},
        startup: new Promise((r) => (readyStartup = r)),
      }),
    };
    const samples: Array<{ phases: Record<string, number> }> = [];
    const resultP = runJobPhase(deps, {
      ...opts(fakeStore()),
      onJobStartup: (s) => samples.push(s),
    });

    for (let i = 0; i < 50 && !restoreSpawned; i++) await new Promise((r) => setImmediate(r));
    expect(restoreSpawned).toBe(true);
    clock += 60_000; // the agent's bring-up; the restore waits in the channel
    readyStartup({ container_start: 1 });
    await new Promise((r) => setImmediate(r));
    clock += 2_000; // the restore itself
    finishRestore();

    expect((await resultP).status).toBe('success');
    const restore = samples.find((s) => 'cache_restore' in s.phases);
    expect(restore?.phases.cache_restore).toBe(2_000);
  });

  it('skips the save on an exact restore hit', async () => {
    const records: SpawnRecord[] = [];
    const store = fakeStore({ [`${cacheObjectPrefix('org', 'proj')}img-abc123`]: 1 });
    const { deps } = makeDeps(recordingSpawn(records, () => 0));

    await runJobPhase(deps, opts(store));

    expect(records[0].env.AH_CACHE_STATUS).toBe('hit');
    expect(records[2].env.AH_CACHE_STATUS).toBe('skip');
    expect(store.presignPut).not.toHaveBeenCalled();
  });

  it('does not run or presign the save when a job step fails, and marks it skipped', async () => {
    const records: SpawnRecord[] = [];
    const store = fakeStore();
    const { deps, upsertStep } = makeDeps(
      recordingSpawn(records, (run) => (run === './run_e2e_ci.sh' ? 1 : 0)),
    );

    const result = await runJobPhase(deps, { ...opts(store), config: noRetries(CACHED_JOB) });

    expect(result.status).toBe('failure');
    expect(records.map((r) => r.name)).toEqual(['Restore cache (e2e-images)', 'Tests']);
    expect(store.presignPut).not.toHaveBeenCalled();
    const skipped = upsertStep.mock.calls.filter((c) => c[3] === 'skipped');
    expect(skipped.map((c) => c[2])).toEqual(['e2e /  / Save cache (e2e-images)']);
  });

  it('still runs the cache steps, as logged no-ops, when no store is configured', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(recordingSpawn(records, () => 0));

    const result = await runJobPhase(deps, opts(null));

    expect(result.status).toBe('success');
    expect(records.map((r) => r.env.AH_CACHE_STATUS)).toEqual(['disabled', undefined, 'disabled']);
  });

  it('plans no cache steps for a host job (no /finalize-cache mount)', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(recordingSpawn(records, () => 0));
    const hostCfg = config(CACHED_JOB.replace('ubuntu-24.04', 'host'));

    await runJobPhase(deps, { ...opts(fakeStore()), config: hostCfg });

    expect(records.map((r) => r.name)).toEqual(['Tests']);
  });
});

describe('cache step failures never fail a job', () => {
  beforeEach(() => vi.stubEnv('FINALIZE_RUNNER_RESOURCE_PROFILE', 'unconstrained'));
  afterEach(() => vi.unstubAllEnvs());

  const isCache = (name: string) => name.includes(' cache (');

  it('gives cache steps their own bounded deadline', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(recordingSpawn(records, () => 0));
    await runJobPhase(deps, opts(fakeStore()));
    for (const r of records.filter((r) => isCache(r.name))) {
      expect(r.deadlineMs).toBe(30 * 60_000);
    }
  });

  it('keeps a passing job green when its save step fails or the runner dies during the save', async () => {
    for (const saveOutcome of [1, 124, 'lost'] as Outcome[]) {
      const records: SpawnRecord[] = [];
      const { deps } = makeDeps(
        recordingSpawn(records, (_run, name) => (name.startsWith('Save') ? saveOutcome : 0)),
      );
      const result = await runJobPhase(deps, {
        ...opts(fakeStore()),
        config: noRetries(CACHED_JOB),
      });
      expect(result.status, `save outcome ${saveOutcome}`).toBe('success');
      expect(records.map((r) => r.name)).toEqual([
        'Restore cache (e2e-images)',
        'Tests',
        'Save cache (e2e-images)',
      ]);
    }
  });

  it('runs the job cold when the restore step fails', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(
      recordingSpawn(records, (_run, name) => (name.startsWith('Restore') ? 124 : 0)),
    );
    const result = await runJobPhase(deps, { ...opts(fakeStore()), config: noRetries(CACHED_JOB) });
    expect(result.status).toBe('success');
    expect(records.map((r) => r.name)).toContain('Tests');
  });

  it('still fails the job on a real test failure after a failed restore', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(recordingSpawn(records, () => 1));
    const result = await runJobPhase(deps, { ...opts(fakeStore()), config: noRetries(CACHED_JOB) });
    expect(result.status).toBe('failure');
    expect(result.failedStep?.name).toContain('Tests');
  });

  it('treats a runner lost during restore as infra (retried), not as a cache warning', async () => {
    const records: SpawnRecord[] = [];
    const { deps } = makeDeps(
      recordingSpawn(records, (_run, name) => (name.startsWith('Restore') ? 'lost' : 0)),
    );
    const result = await runJobPhase(deps, {
      ...opts(fakeStore()),
      config: noRetries(CACHED_JOB),
    });
    expect(result.status).toBe('infra_error');
    // Three attempts on fresh agents, each stopping at the restore.
    expect(records.every((r) => r.name.startsWith('Restore'))).toBe(true);
  });

  it('preserves a cancellation that lands during the restore step', async () => {
    const records: SpawnRecord[] = [];
    const { signal, abort } = createFinalizeRunSignal();
    const { deps } = makeDeps(
      recordingSpawn(records, (_run, name) => {
        if (name.startsWith('Restore')) abort();
        return 0;
      }),
    );
    await runJobPhase(deps, { ...opts(fakeStore()), signal });
    expect(records.map((r) => r.name)).toEqual(['Restore cache (e2e-images)']);
  });
});

describe('cache setup is bounded and cancellable', () => {
  beforeEach(() => vi.stubEnv('FINALIZE_RUNNER_RESOURCE_PROFILE', 'unconstrained'));
  afterEach(() => vi.unstubAllEnvs());

  function stalledStore(): CacheStore & { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    const never = (_k: string, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      return new Promise<never>(() => {});
    };
    return {
      signals,
      exists: vi.fn(never),
      newestWithPrefix: vi.fn(never),
      presignGet: vi.fn(async () => ''),
      presignPut: vi.fn(async () => ''),
    };
  }

  it('runs the job cold when a cache lookup never settles', async () => {
    const records: SpawnRecord[] = [];
    const store = stalledStore();
    const { deps, release } = makeDeps(recordingSpawn(records, () => 0));

    const result = await runJobPhase(deps, {
      ...opts(store),
      config: noRetries(CACHED_JOB),
      cacheSetupTimeoutMs: 20,
    });

    expect(result.status).toBe('success');
    expect(records.map((r) => r.name)).toEqual([
      'Restore cache (e2e-images)',
      'Tests',
      'Save cache (e2e-images)',
    ]);
    expect(records[0].env.AH_CACHE_STATUS).toBe('error');
    expect(records[0].env.AH_CACHE_MESSAGE).toContain('timed out');
    expect(records[2].env.AH_CACHE_STATUS).toBe('error'); // nothing presigned, not saved
    expect(store.presignPut).not.toHaveBeenCalled();
    expect(store.signals.every((s) => s.aborted)).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('unwinds a stalled lookup on Stop and releases the runner without running steps', async () => {
    const records: SpawnRecord[] = [];
    const store = stalledStore();
    const { deps, release } = makeDeps(recordingSpawn(records, () => 0));
    const { signal, abort } = createFinalizeRunSignal();

    const pending = runJobPhase(deps, {
      ...opts(store),
      signal,
      cacheSetupTimeoutMs: 10 * 60_000,
    });
    await vi.waitFor(() => expect(store.exists).toHaveBeenCalled());
    abort();
    await pending;

    expect(records).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(store.signals.every((s) => s.aborted)).toBe(true);
  });
});

function noRetries(yaml: string): CiConfig {
  return config(yaml.replace('    cache:', '    retries: 0\n    cache:'));
}
