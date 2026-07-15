import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from '../types.js';
import { classifyRunFlakeRecovery, recordJobAttemptsForRound } from './flake-gate.js';
import { serializeFlakeGate, hasFlakeRecoveredJobs } from './flake-recovery.js';
import type { CiConfigV2 } from './ci-config-v2.js';

/**
 * End-to-end retry-history round-trip against a real in-memory sqlite, using
 * the production DDL + prepared-statement SQL for the new tables/columns. This
 * is the regression test for the bug: a job that fails round N and passes
 * round M after a fixer commit that missed its code paths is a laundered
 * flake, not merge-safe.
 */
function makeDb(): { db: Database.Database; stmts: Pick<Stmts, KnownStmt> } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE finalize_runs (id TEXT PRIMARY KEY, flake_recovered_jobs TEXT);
    CREATE TABLE finalize_run_jobs (
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      exit_code INTEGER,
      started_at INTEGER,
      ended_at INTEGER,
      attempt TEXT,
      PRIMARY KEY (run_id, job_id, matrix_key)
    );
    CREATE TABLE finalize_run_job_attempts (
      run_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '',
      round INTEGER NOT NULL,
      state TEXT NOT NULL,
      exit_code INTEGER,
      head_sha TEXT,
      recorded_at INTEGER,
      PRIMARY KEY (run_id, job_id, matrix_key, round)
    );
  `);
  db.prepare('INSERT INTO finalize_runs (id, flake_recovered_jobs) VALUES (?, NULL)').run('r1');

  const stmts = {
    upsertFinalizeRunJob: db.prepare(
      `INSERT INTO finalize_run_jobs (run_id, job_id, matrix_key, state, exit_code, started_at, ended_at, attempt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, job_id, matrix_key) DO UPDATE SET
         state = excluded.state, exit_code = excluded.exit_code,
         started_at = CASE
           WHEN excluded.state = 'queued' THEN NULL
           ELSE COALESCE(excluded.started_at, finalize_run_jobs.started_at)
         END,
         ended_at = excluded.ended_at,
         attempt = CASE
           WHEN excluded.state = 'queued' THEN NULL
           WHEN excluded.state = 'running' THEN excluded.attempt
           ELSE finalize_run_jobs.attempt
         END
       WHERE excluded.state IN ('queued', 'running')
          OR (finalize_run_jobs.attempt IS excluded.attempt
              AND finalize_run_jobs.state IN ('queued', 'running'))`,
    ),
    listFinalizeRunJobsForRun: db.prepare(
      `SELECT run_id, job_id, matrix_key, state, exit_code, started_at, ended_at
         FROM finalize_run_jobs WHERE run_id = ? ORDER BY job_id ASC, matrix_key ASC`,
    ),
    upsertFinalizeRunJobAttempt: db.prepare(
      `INSERT INTO finalize_run_job_attempts (run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, job_id, matrix_key, round) DO UPDATE SET
         state = excluded.state, exit_code = excluded.exit_code,
         head_sha = excluded.head_sha, recorded_at = excluded.recorded_at`,
    ),
    listFinalizeRunJobAttemptsForRun: db.prepare(
      `SELECT run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at
         FROM finalize_run_job_attempts WHERE run_id = ? ORDER BY round ASC, job_id ASC, matrix_key ASC`,
    ),
    setFinalizeRunFlakeRecoveredJobs: db.prepare(
      `UPDATE finalize_runs SET flake_recovered_jobs = ? WHERE id = ?`,
    ),
  } as unknown as Pick<Stmts, KnownStmt>;
  return { db, stmts };
}

type KnownStmt =
  | 'upsertFinalizeRunJob'
  | 'listFinalizeRunJobsForRun'
  | 'upsertFinalizeRunJobAttempt'
  | 'listFinalizeRunJobAttemptsForRun'
  | 'setFinalizeRunFlakeRecoveredJobs';

const config: CiConfigV2 = {
  version: 2,
  on: ['finalize'],
  timeoutMinutes: 30,
  jobs: {
    e2e: {
      runsOn: 'ubuntu-24.04',
      failFast: true,
      warmup: false,
      needs: [],
      matrixInclude: [],
      paths: ['e2e/**'],
      steps: [{ name: 's', run: 'echo' }],
    },
    backend: {
      runsOn: 'ubuntu-24.04',
      failFast: true,
      warmup: false,
      needs: [],
      matrixInclude: [],
      paths: ['server/**'],
      steps: [{ name: 's', run: 'echo' }],
    },
  },
};

describe('flake-recovery DB round-trip', () => {
  let db: Database.Database;
  let stmts: Pick<Stmts, KnownStmt>;

  beforeEach(() => {
    ({ db, stmts } = makeDb());
  });

  it('records per-round history and classifies a laundered flake vs a real fix', async () => {
    let round = 0;
    // Model the real per-round lifecycle: each fix round re-queues the row,
    // starts a fresh execution (new nonce), and terminalizes it with that
    // nonce. Writing a terminal directly onto a terminal row is exactly what
    // the upsert's live-state guard rejects (duplicate/replayed terminals).
    const upsertJob = (jobId: string, state: string, exit: number): void => {
      const attempt = `${jobId}-round-${round}`;
      stmts.upsertFinalizeRunJob.run('r1', jobId, '', 'queued', null, null, null, null);
      stmts.upsertFinalizeRunJob.run('r1', jobId, '', 'running', null, 1, null, attempt);
      stmts.upsertFinalizeRunJob.run('r1', jobId, '', state, exit, 1, 2, attempt);
    };

    // ── Round 1 on head h1: both jobs fail. ───────────────────────────
    round = 1;
    upsertJob('e2e', 'failed', 1);
    upsertJob('backend', 'failed', 1);
    recordJobAttemptsForRound({ stmts, now: () => 1000 }, { runId: 'r1', round, headSha: 'h1' });

    // ── Fixer commit lands (head → h2) touching only server/**. ───────
    // Round 2: the backend fix worked; e2e ALSO flips green even though
    // nothing in e2e's paths changed — the laundered flake.
    round = 2;
    upsertJob('e2e', 'passed', 0);
    upsertJob('backend', 'passed', 0);
    recordJobAttemptsForRound({ stmts, now: () => 2000 }, { runId: 'r1', round, headSha: 'h2' });

    // Retry history persisted four rows (2 jobs × 2 rounds).
    const attempts = stmts.listFinalizeRunJobAttemptsForRun.all('r1') as Array<{
      job_id: string;
      round: number;
      state: string;
      head_sha: string;
    }>;
    expect(attempts).toHaveLength(4);
    expect(attempts.filter((a) => a.state === 'failed')).toHaveLength(2);
    expect(attempts.find((a) => a.job_id === 'e2e' && a.round === 1)?.state).toBe('failed');
    expect(attempts.find((a) => a.job_id === 'e2e' && a.round === 2)?.state).toBe('passed');

    const gitChangedFiles = vi.fn(async () => ['server/api.ts']);
    const gate = await classifyRunFlakeRecovery(
      { stmts, gitChangedFiles },
      { runId: 'r1', worktreePath: '/wt', config, expectAttempts: true, attemptsPersisted: true },
    );

    // e2e laundered a flake (recovered, no e2e/** change); backend was a real
    // fix so it is NOT carried in the gate's flagged jobs.
    expect(gate.status).toBe('flake_recovered');
    expect(gate.jobs.map((v) => v.jobId)).toEqual(['e2e']);
    const e2e = gate.jobs.find((v) => v.jobId === 'e2e')!;
    expect(e2e.failedRounds).toEqual([1]);
    expect(e2e.passedRound).toBe(2);

    // Persist + read back the gate column.
    stmts.setFinalizeRunFlakeRecoveredJobs.run(serializeFlakeGate(gate), 'r1');
    const run = db
      .prepare('SELECT flake_recovered_jobs FROM finalize_runs WHERE id = ?')
      .get('r1') as {
      flake_recovered_jobs: string | null;
    };
    expect(hasFlakeRecoveredJobs(run)).toBe(true);
  });

  it('a clean run leaves the gate column NULL', async () => {
    stmts.upsertFinalizeRunJob.run('r1', 'e2e', '', 'passed', 0, 1, 2, null);
    const ok = recordJobAttemptsForRound(
      { stmts, now: () => 1 },
      { runId: 'r1', round: 1, headSha: 'h1' },
    );
    expect(ok).toBe(true);
    const gate = await classifyRunFlakeRecovery(
      { stmts, gitChangedFiles: vi.fn(async () => []) },
      { runId: 'r1', worktreePath: '/wt', config, expectAttempts: true, attemptsPersisted: true },
    );
    expect(gate.status).toBe('clean');
    stmts.setFinalizeRunFlakeRecoveredJobs.run(serializeFlakeGate(gate), 'r1');
    const run = db
      .prepare('SELECT flake_recovered_jobs FROM finalize_runs WHERE id = ?')
      .get('r1') as {
      flake_recovered_jobs: string | null;
    };
    expect(run.flake_recovered_jobs).toBeNull();
    expect(hasFlakeRecoveredJobs(run)).toBe(false);
  });
});
