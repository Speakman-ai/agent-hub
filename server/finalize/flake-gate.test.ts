import { describe, it, expect, vi } from 'vitest';
import { recordJobAttemptsForRound, classifyRunFlakeRecovery } from './flake-gate.js';
import type { FinalizeRunJobAttemptRow, FinalizeRunJobRow, Stmts } from '../types.js';
import type { CiConfig } from './ci-config-jobs.js';

function jobRow(
  job_id: string,
  state: FinalizeRunJobRow['state'],
  matrix_key = '',
  exit_code: number | null = state === 'passed' ? 0 : 1,
): FinalizeRunJobRow {
  return { run_id: 'r1', job_id, matrix_key, state, exit_code, started_at: 1, ended_at: 2 };
}

describe('recordJobAttemptsForRound', () => {
  it('appends one attempt row per current job state and returns true on success', () => {
    const run = vi.fn();
    const all = vi.fn(() => [jobRow('e2e', 'failed'), jobRow('backend', 'passed')]);
    const stmts = {
      listFinalizeRunJobsForRun: { all },
      upsertFinalizeRunJobAttempt: { run },
    } as unknown as Pick<Stmts, 'listFinalizeRunJobsForRun' | 'upsertFinalizeRunJobAttempt'>;

    const ok = recordJobAttemptsForRound(
      { stmts, now: () => 999 },
      { runId: 'r1', round: 2, headSha: 'deadbeef' },
    );

    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenCalledWith('r1', 'e2e', '', 2, 'failed', 1, 'deadbeef', 999);
    expect(run).toHaveBeenCalledWith('r1', 'backend', '', 2, 'passed', 0, 'deadbeef', 999);
  });

  it('returns false (fail-closed) without throwing when the list query fails', () => {
    const stmts = {
      listFinalizeRunJobsForRun: {
        all: () => {
          throw new Error('db down');
        },
      },
      upsertFinalizeRunJobAttempt: { run: vi.fn() },
    } as unknown as Pick<Stmts, 'listFinalizeRunJobsForRun' | 'upsertFinalizeRunJobAttempt'>;
    let result: boolean | undefined;
    expect(() => {
      result = recordJobAttemptsForRound({ stmts }, { runId: 'r1', round: 1, headSha: 'x' });
    }).not.toThrow();
    expect(result).toBe(false);
  });

  it('returns false when any per-job upsert fails', () => {
    const all = vi.fn(() => [jobRow('e2e', 'failed'), jobRow('backend', 'passed')]);
    let calls = 0;
    const stmts = {
      listFinalizeRunJobsForRun: { all },
      upsertFinalizeRunJobAttempt: {
        run: () => {
          calls += 1;
          if (calls === 1) throw new Error('write failed');
        },
      },
    } as unknown as Pick<Stmts, 'listFinalizeRunJobsForRun' | 'upsertFinalizeRunJobAttempt'>;
    const ok = recordJobAttemptsForRound({ stmts }, { runId: 'r1', round: 1, headSha: 'x' });
    expect(ok).toBe(false);
    // Still attempts the remaining job rather than bailing on the first failure.
    expect(calls).toBe(2);
  });
});

function attemptRow(
  job_id: string,
  round: number,
  state: FinalizeRunJobAttemptRow['state'],
  head_sha: string | null,
  matrix_key = '',
): FinalizeRunJobAttemptRow {
  return {
    run_id: 'r1',
    job_id,
    matrix_key,
    round,
    state,
    exit_code: state === 'passed' ? 0 : 1,
    head_sha,
    recorded_at: 1,
  };
}

function attemptsStmts(rows: FinalizeRunJobAttemptRow[]) {
  return {
    listFinalizeRunJobAttemptsForRun: { all: vi.fn(() => rows) },
  } as unknown as Pick<Stmts, 'listFinalizeRunJobAttemptsForRun'>;
}

const v2Config = (paths?: Record<string, string[]>): CiConfig => ({
  version: 2,
  on: ['finalize'],
  timeoutMinutes: 30,
  jobs: {
    e2e: {
      runsOn: 'ubuntu-24.04',
      failFast: true,
      warmup: false,
      needs: [],
      retries: 2,
      matrixInclude: [],
      ...(paths?.e2e ? { paths: paths.e2e } : {}),
      steps: [{ name: 's', run: 'echo' }],
    },
    backend: {
      runsOn: 'ubuntu-24.04',
      failFast: true,
      warmup: false,
      needs: [],
      retries: 2,
      matrixInclude: [],
      ...(paths?.backend ? { paths: paths.backend } : {}),
      steps: [{ name: 's', run: 'echo' }],
    },
  },
});

describe('classifyRunFlakeRecovery', () => {
  it('returns clean when no attempts recorded and none expected (v1-style)', async () => {
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts([]) },
      { runId: 'r1', worktreePath: '/wt', config: v2Config() },
    );
    expect(gate).toEqual({ status: 'clean', jobs: [] });
  });

  it('flags a flake recovery when the fixer commit missed the job paths', async () => {
    const rows = [
      attemptRow('e2e', 1, 'failed', 'h1'),
      attemptRow('backend', 1, 'failed', 'h1'),
      attemptRow('e2e', 2, 'passed', 'h2'), // recovered, but...
      attemptRow('backend', 2, 'passed', 'h2'),
    ];
    // The fix between h1..h2 only touched server/** (backend paths). e2e
    // recovered with nothing in its paths changed → laundered flake.
    const gitChangedFiles = vi.fn(async () => ['server/api.ts']);
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts(rows), gitChangedFiles },
      {
        runId: 'r1',
        worktreePath: '/wt',
        config: v2Config({ e2e: ['e2e/**'], backend: ['server/**'] }),
        expectAttempts: true,
      },
    );
    expect(gate.status).toBe('flake_recovered');
    // Only the laundered e2e instance is carried; backend was a real fix.
    expect(gate.jobs.map((v) => v.jobId)).toEqual(['e2e']);
    // git diff resolved once for the shared h1..h2 range.
    expect(gitChangedFiles).toHaveBeenCalledWith('/wt', 'h1', 'h2', undefined);
  });

  it('treats recovery with no head change as a flake without calling git', async () => {
    const rows = [
      attemptRow('e2e', 1, 'failed', 'sameHead'),
      attemptRow('e2e', 2, 'passed', 'sameHead'),
    ];
    const gitChangedFiles = vi.fn(async () => ['x']);
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts(rows), gitChangedFiles },
      { runId: 'r1', worktreePath: '/wt', config: v2Config(), expectAttempts: true },
    );
    expect(gate.status).toBe('flake_recovered');
    expect(gate.jobs[0].jobId).toBe('e2e');
    expect(gitChangedFiles).not.toHaveBeenCalled();
  });

  it('clean first-pass jobs yield a clean gate', async () => {
    const rows = [attemptRow('e2e', 1, 'passed', 'h1')];
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts(rows), gitChangedFiles: vi.fn(async () => []) },
      { runId: 'r1', worktreePath: '/wt', config: v2Config(), expectAttempts: true },
    );
    expect(gate.status).toBe('clean');
    expect(gate.jobs).toEqual([]);
  });

  // ── Fail-closed paths (reviewer feedback) ─────────────────────────────────

  it('blocks when the attempts query throws (cannot read evidence)', async () => {
    const stmts = {
      listFinalizeRunJobAttemptsForRun: {
        all: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Pick<Stmts, 'listFinalizeRunJobAttemptsForRun'>;
    const gate = await classifyRunFlakeRecovery(
      { stmts },
      { runId: 'r1', worktreePath: '/wt', config: null },
    );
    expect(gate.status).toBe('blocked');
    expect(gate.reason).toContain('query failed');
  });

  it('blocks when per-round history failed to persist this run', async () => {
    const all = vi.fn(() => []);
    const stmts = {
      listFinalizeRunJobAttemptsForRun: { all },
    } as unknown as Pick<Stmts, 'listFinalizeRunJobAttemptsForRun'>;
    const gate = await classifyRunFlakeRecovery(
      { stmts },
      {
        runId: 'r1',
        worktreePath: '/wt',
        config: v2Config(),
        expectAttempts: true,
        attemptsPersisted: false,
      },
    );
    expect(gate.status).toBe('blocked');
    expect(gate.reason).toContain('failed to persist');
    // Doesn't even bother querying — the evidence is known-incomplete.
    expect(all).not.toHaveBeenCalled();
  });

  it('blocks when the git diff range cannot be resolved for a recovered job', async () => {
    const rows = [attemptRow('e2e', 1, 'failed', 'h1'), attemptRow('e2e', 2, 'passed', 'h2')];
    // git diff failed (returns null) — we can't prove a fixer commit existed.
    const gitChangedFiles = vi.fn(async () => null);
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts(rows), gitChangedFiles },
      { runId: 'r1', worktreePath: '/wt', config: v2Config(), expectAttempts: true },
    );
    expect(gate.status).toBe('blocked');
    expect(gate.reason).toContain('change-set');
    expect(gitChangedFiles).toHaveBeenCalledWith('/wt', 'h1', 'h2', undefined);
  });

  it('blocks when a v2 run expected history but none exists', async () => {
    const gate = await classifyRunFlakeRecovery(
      { stmts: attemptsStmts([]) },
      { runId: 'r1', worktreePath: '/wt', config: v2Config(), expectAttempts: true },
    );
    expect(gate.status).toBe('blocked');
    expect(gate.reason).toContain('missing');
  });
});
