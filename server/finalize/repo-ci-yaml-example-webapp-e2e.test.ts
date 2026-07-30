import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'url';
import { loadCiConfigFromFile, parseCiConfig } from './ci-config.js';
import { buildFinalizeBuiltinEnv, expandJobInstances } from './ci-config-jobs.js';
import { runJobPhase } from './job-runner.js';
import type { SpawnedStep, SpawnStepFn, StepRunnerDeps } from './step-runner.js';

const __filename = fileURLToPath(import.meta.url);
const E2E_FIXTURE = path.join(path.dirname(__filename), 'fixtures', 'example-webapp-e2e.ci.yaml');

function makeDeps(spawnStep: SpawnStepFn): StepRunnerDeps {
  return {
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
    now: () => 1_000_000,
    spawnHardTimeoutMs: 5_000,
  };
}

describe('runJobPhase', () => {
  it('runs matrix shards in parallel and fails when any shard fails', async () => {
    const spawnStep = vi.fn((): SpawnedStep => {
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
    });

    const parsed = parseCiConfig(`
version: 2
on: [finalize]
jobs:
  e2e:
    runs-on: host
    fail-fast: false
    matrix:
      include:
        - group: A
          specs: a.cy.ts
        - group: B
          specs: b.cy.ts
    steps:
      - run: echo ok
`);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.config.version !== 2) return;

    const result = await runJobPhase(makeDeps(spawnStep), {
      runId: 'run-1',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess-1',
      branch: 'feat/x',
      headSha: 'abc',
    });

    expect(result.status).toBe('success');
    expect(spawnStep).toHaveBeenCalledTimes(2);
  });
});

describe('webapp e2e fixture', () => {
  it('parses as v2 with a prepare job that the 4 e2e shards depend on', async () => {
    const result = await loadCiConfigFromFile(E2E_FIXTURE);
    expect(result.ok).toBe(true);
    if (!result.ok || result.config.version !== 2) return;
    const builtins = buildFinalizeBuiltinEnv({ branch: 'main', headSha: 'deadbeef' });
    const instances = expandJobInstances(result.config, builtins);

    // One prepare instance (FINALIZE_WARMUP), and 4 e2e shards that need it.
    const prepare = instances.filter((i) => i.jobId === 'prepare');
    const shards = instances.filter((i) => i.jobId === 'e2e');
    expect(prepare).toHaveLength(1);
    expect(prepare[0].steps[0].env?.FINALIZE_WARMUP).toBe('1');
    expect(shards).toHaveLength(4);
    expect(shards.every((i) => i.needs.includes('prepare'))).toBe(true);
    expect(shards.map((i) => i.matrix.group)).toEqual([
      'Profiles & Tasks',
      'Core Workflows',
      'MLS & Routing',
      'Inspection',
    ]);
  });
});
