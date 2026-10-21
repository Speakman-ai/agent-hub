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

function makeDeps(ran: string[]) {
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
  return { deps, upsertStep, upsertJob };
}

/** Last state written per key from an upsert mock (state is argument 3). */
function lastStates(calls: unknown[][], key: (c: unknown[]) => string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const c of calls) out.set(key(c), c[3]);
  return out;
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
  deploy-check:
    runs-on: host
    needs: [build]
    steps:
      - run: echo deploy-check
`;

describe('runJobPhase notSelectedInstances', () => {
  it('does not run left-out instances and records them as not_selected', async () => {
    const parsed = parseCiConfig(CONFIG);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const ran: string[] = [];
    const { deps, upsertStep, upsertJob } = makeDeps(ran);

    const result = await runJobPhase(deps, {
      runId: 'run-1',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'feature',
      headSha: 'abc',
      notSelectedInstances: new Set([jobInstanceKey('e2e', ''), jobInstanceKey('build', '')]),
    });

    // A not_selected dependency counts as a pass, so its dependent still runs.
    expect(result.status).toBe('success');
    expect(ran).toEqual(['echo deploy-check']);
    const jobs = lastStates(upsertJob.mock.calls, (c) => String(c[1]));
    expect(jobs.get('e2e')).toBe('not_selected');
    expect(jobs.get('build')).toBe('not_selected');
    expect(jobs.get('deploy-check')).toBe('passed');
    const steps = lastStates(upsertStep.mock.calls, (c) => String(c[1]));
    expect(steps.get('1')).toBe('not_selected');
    expect(steps.get('2')).toBe('not_selected');
    expect(steps.get('3')).toBe('not_selected');
  });

  it('lets a reused instance keep its rows over not_selected', async () => {
    const parsed = parseCiConfig(CONFIG);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const { deps, upsertJob } = makeDeps([]);
    await runJobPhase(deps, {
      runId: 'run-1',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess',
      branch: 'feature',
      headSha: 'abc',
      reuseInstances: new Set([jobInstanceKey('e2e', '')]),
      notSelectedInstances: new Set([jobInstanceKey('e2e', '')]),
    });
    expect(upsertJob.mock.calls.some((c) => c[1] === 'e2e')).toBe(false);
  });
});

describe('recordJobAttemptsForRound not_selected', () => {
  it('records no attempt for an instance selection left out', () => {
    const upsert = vi.fn();
    recordJobAttemptsForRound(
      {
        stmts: {
          listFinalizeRunJobsForRun: {
            all: vi.fn(() => [
              { job_id: 'build', matrix_key: '', state: 'passed', exit_code: 0 },
              { job_id: 'e2e', matrix_key: '', state: 'not_selected', exit_code: null },
            ]),
          },
          upsertFinalizeRunJobAttempt: { run: upsert },
        } as never,
      },
      { runId: 'run-1', round: 1, headSha: 'abc' },
    );
    expect(upsert.mock.calls.map((c) => c[1])).toEqual(['build']);
  });
});
