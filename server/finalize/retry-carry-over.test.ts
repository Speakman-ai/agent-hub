import '../test/setup.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb, getStmts } from '../db.js';
import type { FinalizeRunJobRow, FinalizeRunStepRow } from '../types.js';
import { jobInstanceKey } from './base-drift-policy.js';
import { parseCiConfig } from './ci-config.js';
import { recordJobAttemptsForRound } from './flake-gate.js';
import { runJobPhase } from './job-runner.js';
import { collectRetryCarryOver } from './retry-carry-over.js';
import type { SpawnedStep, SpawnStepFn, StepRunnerDeps } from './step-runner.js';

vi.mock('./job-container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./job-container.js')>();
  return {
    ...actual,
    startJobContainer: vi.fn().mockResolvedValue(undefined),
    stopJobContainer: vi.fn().mockResolvedValue(undefined),
  };
});

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
    matrix:
      include:
        - group: A
          specs: a.cy.ts
        - group: B
          specs: b.cy.ts
    steps:
      - run: e2e \${FINALIZE_MATRIX_SPECS}
      - run: e2e-report
`;

const HEAD = 'sha-head';

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

function seedRun(id: string, retryOf: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO finalize_runs (
        id, card_id, session_id, project_id, branch, head_sha,
        idempotency_key, status, phase, trigger_source, worktree_path,
        triggered_by_user_id, author_name, author_email,
        active_seconds_consumed, started_at, mode, retry_of_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      'card-1',
      'sess-1',
      'proj-1',
      'feature/x',
      HEAD,
      `idem-${id}`,
      'running',
      'tasks',
      'ui_button',
      '/tmp/wt',
      'user-1',
      'Test User',
      'test@example.com',
      0,
      Date.now(),
      'full',
      retryOf,
    );
}

function deps(ran: string[]): StepRunnerDeps {
  return {
    stmts: {
      ...getStmts(),
      // The checks-summary timeline message needs a real session row; it is
      // not what this test is about.
      addMessage: { run: vi.fn() },
      touchSession: { run: vi.fn() },
      getMessageById: { get: vi.fn() },
    } as unknown as StepRunnerDeps['stmts'],
    broadcast: vi.fn(),
    spawnStep: vi.fn(fakeSpawn((run) => ran.push(run))),
  };
}

function jobs(runId: string): FinalizeRunJobRow[] {
  return getStmts().listFinalizeRunJobsForRun.all(runId) as FinalizeRunJobRow[];
}

function steps(runId: string): FinalizeRunStepRow[] {
  return getStmts().listFinalizeRunStepsForRun.all(runId) as FinalizeRunStepRow[];
}

/**
 * Run the parent's checks phase (all green), then make shard B look like it
 * lost its runner to a Spot reclaim, the way a real parent ends before its
 * infra retry opens.
 */
async function parentWithReclaimedShard(): Promise<string> {
  const parsed = parseCiConfig(CONFIG);
  if (!parsed.ok) throw new Error(parsed.error.message);
  await runJobPhase(deps([]), {
    runId: 'parent',
    config: parsed.config,
    worktreePath: '/tmp/wt',
    sessionId: 'sess-1',
    branch: 'feature/x',
    headSha: HEAD,
  });
  const shardB = jobs('parent').find(
    (j) => j.job_id === 'e2e' && j.matrix_key !== '' && /B/.test(j.matrix_key),
  );
  if (!shardB) throw new Error('shard B not planned');
  const db = getDb();
  db.prepare(
    `UPDATE finalize_run_jobs SET state = 'failed', exit_code = -1
      WHERE run_id = 'parent' AND job_id = 'e2e' AND matrix_key = ?`,
  ).run(shardB.matrix_key);
  db.prepare(
    `UPDATE finalize_run_steps SET state = 'failed'
      WHERE run_id = 'parent' AND job_id = 'e2e' AND matrix_key = ?`,
  ).run(shardB.matrix_key);
  db.prepare(
    `UPDATE finalize_run_steps SET log_key = 'logs/' || step_index WHERE run_id = 'parent'`,
  ).run();
  recordJobAttemptsForRound(
    { stmts: getStmts(), now: Date.now, log: () => {} },
    { runId: 'parent', round: 1, headSha: HEAD },
  );
  return shardB.matrix_key;
}

describe('infra retry carry-over', () => {
  beforeEach(() => {
    const db = getDb();
    for (const table of [
      'finalize_run_job_attempts',
      'finalize_run_jobs',
      'finalize_run_steps',
      'finalize_runs',
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    seedRun('parent', null);
    seedRun('retry', 'parent');
  });

  it('re-runs only the reclaimed shard when the retry tests the same commit', async () => {
    const shardB = await parentWithReclaimedShard();
    const parsed = parseCiConfig(CONFIG);
    if (!parsed.ok) throw new Error(parsed.error.message);

    const instances = collectRetryCarryOver(getStmts(), 'parent', HEAD);
    expect(instances.has(jobInstanceKey('e2e', shardB))).toBe(false);
    expect(instances.has(jobInstanceKey('build', ''))).toBe(true);
    expect(instances.size).toBe(2);

    const ran: string[] = [];
    const result = await runJobPhase(deps(ran), {
      runId: 'retry',
      config: parsed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess-1',
      branch: 'feature/x',
      headSha: HEAD,
      carryOver: { fromRunId: 'parent', instances },
    });

    expect(result.status).toBe('success');
    expect(ran).toEqual(['e2e b.cy.ts', 'e2e-report']);
    expect(result.carriedOverInstances?.length).toBe(2);
    expect(jobs('retry').map((j) => j.state)).toEqual(['passed', 'passed', 'passed']);
    // Carried steps keep the parent's log location so their output stays viewable.
    const parentSteps = steps('parent');
    const retrySteps = steps('retry');
    expect(retrySteps).toHaveLength(parentSteps.length);
    for (const row of retrySteps) {
      if (row.matrix_key === shardB) continue;
      expect(row.log_key).toBe(`logs/${row.step_index}`);
      expect(row.state).toBe('passed');
    }
  });

  it('carries nothing over when the retry tests a different commit', async () => {
    await parentWithReclaimedShard();
    expect(collectRetryCarryOver(getStmts(), 'parent', 'sha-after-rebase').size).toBe(0);
  });

  it('runs every candidate whose step layout no longer matches the parent', async () => {
    await parentWithReclaimedShard();
    const instances = collectRetryCarryOver(getStmts(), 'parent', HEAD);
    // An extra build step changes build's layout and shifts every later global
    // step index, so neither build nor shard A may attach the parent's rows.
    const changed = parseCiConfig(
      CONFIG.replace(
        '      - run: echo build',
        '      - run: echo build\n      - run: echo build-extra',
      ),
    );
    if (!changed.ok) throw new Error(changed.error.message);

    const ran: string[] = [];
    const result = await runJobPhase(deps(ran), {
      runId: 'retry',
      config: changed.config,
      worktreePath: '/tmp/wt',
      sessionId: 'sess-1',
      branch: 'feature/x',
      headSha: HEAD,
      carryOver: { fromRunId: 'parent', instances },
    });

    expect(result.status).toBe('success');
    expect(ran.sort()).toEqual([
      'e2e a.cy.ts',
      'e2e b.cy.ts',
      'e2e-report',
      'e2e-report',
      'echo build',
      'echo build-extra',
    ]);
    expect(result.carriedOverInstances).toBeUndefined();
  });
});

describe('collectRetryCarryOver', () => {
  const stmts = (jobRows: unknown[], attemptRows: unknown[]) =>
    ({
      listFinalizeRunJobsForRun: { all: () => jobRows },
      listFinalizeRunJobAttemptsForRun: { all: () => attemptRows },
    }) as never;

  it('uses the latest round, so a pass that later failed is not carried', () => {
    const keys = collectRetryCarryOver(
      stmts(
        [{ job_id: 'build', matrix_key: '', state: 'passed' }],
        [
          { job_id: 'build', matrix_key: '', round: 1, state: 'passed', head_sha: HEAD },
          { job_id: 'build', matrix_key: '', round: 2, state: 'failed', head_sha: HEAD },
        ],
      ),
      'parent',
      HEAD,
    );
    expect(keys.size).toBe(0);
  });

  it('returns nothing when the parent rows cannot be read', () => {
    const broken = {
      listFinalizeRunJobsForRun: {
        all: () => {
          throw new Error('db gone');
        },
      },
      listFinalizeRunJobAttemptsForRun: { all: () => [] },
    } as never;
    expect(collectRetryCarryOver(broken, 'parent', HEAD).size).toBe(0);
  });
});
