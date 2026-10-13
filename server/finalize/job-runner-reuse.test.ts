import { describe, expect, it, vi } from 'vitest';
import { parseCiConfig } from './ci-config.js';
import { runJobPhase } from './job-runner.js';
import { jobInstanceKey } from './base-drift-policy.js';
import { recordJobAttemptsForRound } from './flake-gate.js';
import type { SpawnedStep, SpawnStepFn, StepRunnerDeps } from './step-runner.js';

vi.mock('./job-container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./job-container.js')>();
  return {
    ...actual,
    startJobContainer: vi.fn().mockResolvedValue(undefined),
    stopJobContainer: vi.fn().mockResolvedValue(undefined),
  };
});

function fakeSpawn(onRun: (run: string) => void): SpawnStepFn {
  return ({ step }) => {
    onRun(step.run);
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

const CONFIG = `
version: 2
on: [finalize]
jobs:
  build:
    runs-on: host
    steps:
      - run: echo build
  e2e:
    runs-on: host
    steps:
      - run: echo e2e-1
      - run: echo e2e-2
  lint:
    runs-on: host
    steps:
      - run: echo lint
`;

describe('runJobPhase reuseInstances', () => {
  it('skips reused instances without touching their job or step rows', async () => {
    const parsed = parseCiConfig(CONFIG);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const ran: string[] = [];
    const upsertStep = vi.fn();
    const upsertJob = vi.fn();
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
        upsertFinalizeRunJob: { run: upsertJob },
        listFinalizeRunJobsForRun: { all: vi.fn(() => []) },
      } as unknown as StepRunnerDeps['stmts'],
      broadcast: vi.fn(),
      spawnStep: vi.fn(fakeSpawn((run) => ran.push(run))),
    };

    const result = await runJobPhase(deps, {
      runId: 'run-1',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'feature',
      headSha: 'abc',
      reuseInstances: new Set([jobInstanceKey('e2e', '')]),
    });

    expect(result.status).toBe('success');
    expect(ran.sort()).toEqual(['echo build', 'echo lint']);
    expect(upsertJob.mock.calls.some((c) => c[1] === 'e2e')).toBe(false);
    // e2e owns step indexes 2 and 3; lint keeps index 4 so the reused rows
    // stay where the previous round wrote them.
    const stepIndexes = new Set(upsertStep.mock.calls.map((c) => c[1]));
    expect(stepIndexes.has(2)).toBe(false);
    expect(stepIndexes.has(3)).toBe(false);
    expect(stepIndexes.has(1)).toBe(true);
    expect(stepIndexes.has(4)).toBe(true);
  });
});

describe('recordJobAttemptsForRound excludeInstances', () => {
  it('writes no round row for an instance that carried an earlier result', () => {
    const upsert = vi.fn();
    const ok = recordJobAttemptsForRound(
      {
        stmts: {
          listFinalizeRunJobsForRun: {
            all: vi.fn(() => [
              { job_id: 'build', matrix_key: '', state: 'passed', exit_code: 0 },
              { job_id: 'e2e', matrix_key: '', state: 'passed', exit_code: 0 },
            ]),
          },
          upsertFinalizeRunJobAttempt: { run: upsert },
        } as never,
      },
      {
        runId: 'run-1',
        round: 2,
        headSha: 'def',
        excludeInstances: new Set([jobInstanceKey('e2e', '')]),
      },
    );
    expect(ok).toBe(true);
    expect(upsert.mock.calls.map((c) => c[1])).toEqual(['build']);
  });
});
