import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Stmts } from '../types.js';
import { loadActiveQuarantine, recordRunTestHistory } from './quarantine-gate.js';
import { isInstanceQuarantined } from './quarantine.js';

/**
 * End-to-end round-trip against a real in-memory sqlite using the production
 * DDL + prepared-statement SQL for finalize_test_history + finalize_quarantine.
 * Guards the ingestion path (per-round upsert collapses to the run's final
 * per-instance outcome) and the quarantine load path.
 */
type KnownStmt =
  | 'upsertFinalizeRunJobAttempt'
  | 'listFinalizeRunJobAttemptsForRun'
  | 'upsertFinalizeTestHistory'
  | 'listFinalizeTestHistoryForProject'
  | 'upsertFinalizeQuarantine'
  | 'listFinalizeQuarantineForProject';

function makeDb(): { db: Database.Database; stmts: Pick<Stmts, KnownStmt> } {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE finalize_run_job_attempts (
      run_id TEXT NOT NULL, job_id TEXT NOT NULL, matrix_key TEXT NOT NULL DEFAULT '',
      round INTEGER NOT NULL, state TEXT NOT NULL, exit_code INTEGER, head_sha TEXT,
      recorded_at INTEGER, PRIMARY KEY (run_id, job_id, matrix_key, round)
    );
    CREATE TABLE finalize_test_history (
      run_id TEXT NOT NULL, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '', branch TEXT, head_sha TEXT,
      final_state TEXT NOT NULL, flaked INTEGER NOT NULL DEFAULT 0, recorded_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, job_id, matrix_key)
    );
    CREATE TABLE finalize_quarantine (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, job_id TEXT NOT NULL,
      matrix_key TEXT NOT NULL DEFAULT '', owner TEXT NOT NULL, reason TEXT,
      quarantined_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_by TEXT,
      UNIQUE (project_id, job_id, matrix_key)
    );
  `);
  const stmts = {
    upsertFinalizeRunJobAttempt: db.prepare(
      `INSERT INTO finalize_run_job_attempts (run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, job_id, matrix_key, round) DO UPDATE SET state = excluded.state`,
    ),
    listFinalizeRunJobAttemptsForRun: db.prepare(
      `SELECT run_id, job_id, matrix_key, round, state, exit_code, head_sha, recorded_at
         FROM finalize_run_job_attempts WHERE run_id = ? ORDER BY round ASC, job_id ASC`,
    ),
    upsertFinalizeTestHistory: db.prepare(
      `INSERT INTO finalize_test_history (run_id, project_id, job_id, matrix_key, branch, head_sha, final_state, flaked, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id, job_id, matrix_key) DO UPDATE SET
         final_state = excluded.final_state, flaked = excluded.flaked,
         head_sha = excluded.head_sha, branch = excluded.branch, recorded_at = excluded.recorded_at`,
    ),
    listFinalizeTestHistoryForProject: db.prepare(
      `SELECT run_id, project_id, job_id, matrix_key, branch, head_sha, final_state, flaked, recorded_at
         FROM finalize_test_history WHERE project_id = ? AND recorded_at >= ? ORDER BY recorded_at DESC`,
    ),
    upsertFinalizeQuarantine: db.prepare(
      `INSERT INTO finalize_quarantine (id, project_id, job_id, matrix_key, owner, reason, quarantined_at, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, job_id, matrix_key) DO UPDATE SET
         owner = excluded.owner, reason = excluded.reason, quarantined_at = excluded.quarantined_at,
         expires_at = excluded.expires_at, created_by = excluded.created_by`,
    ),
    listFinalizeQuarantineForProject: db.prepare(
      `SELECT id, project_id, job_id, matrix_key, owner, reason, quarantined_at, expires_at, created_by
         FROM finalize_quarantine WHERE project_id = ? ORDER BY expires_at ASC`,
    ),
  } as unknown as Pick<Stmts, KnownStmt>;
  return { db, stmts };
}

function recordRound(
  stmts: Pick<Stmts, KnownStmt>,
  runId: string,
  round: number,
  jobs: Array<{ jobId: string; state: string; head: string }>,
): void {
  for (const j of jobs) {
    stmts.upsertFinalizeRunJobAttempt.run(runId, j.jobId, '', round, j.state, 0, j.head, 1);
  }
}

describe('recordRunTestHistory', () => {
  let db: Database.Database;
  let stmts: Pick<Stmts, KnownStmt>;
  beforeEach(() => {
    ({ db, stmts } = makeDb());
  });

  it('collapses per-round attempts into one history row per instance; same-head rerun = flake', () => {
    // Round 1 @ h1: both fail. Round 2 @ h1 (no new commit landed): both pass.
    // A pass on the same head it failed on is a bare rerun-to-green = flake.
    recordRound(stmts, 'r1', 1, [
      { jobId: 'e2e', state: 'failed', head: 'h1' },
      { jobId: 'backend', state: 'failed', head: 'h1' },
    ]);
    recordRunTestHistory(
      { stmts, now: () => 100 },
      { runId: 'r1', projectId: 'proj', branch: 'feat', headSha: 'h1' },
    );
    recordRound(stmts, 'r1', 2, [
      { jobId: 'e2e', state: 'passed', head: 'h1' },
      { jobId: 'backend', state: 'passed', head: 'h1' },
    ]);
    const written = recordRunTestHistory(
      { stmts, now: () => 200 },
      { runId: 'r1', projectId: 'proj', branch: 'feat', headSha: 'h1' },
    );
    expect(written).toBe(2);

    const rows = db
      .prepare(
        'SELECT job_id, final_state, flaked, head_sha FROM finalize_test_history ORDER BY job_id',
      )
      .all() as Array<{ job_id: string; final_state: string; flaked: number; head_sha: string }>;
    // Upsert keyed on (run, instance): two rows total, reflecting the LAST round.
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.job_id === 'e2e')).toMatchObject({
      final_state: 'passed',
      flaked: 1,
      head_sha: 'h1',
    });
    expect(rows.find((r) => r.job_id === 'backend')).toMatchObject({
      final_state: 'passed',
      flaked: 1,
    });
  });

  it('a fix that moved the head (failed@h1 -> passed@h2) is recorded as NOT flaked', () => {
    // The realistic finalize fix loop: the agent commits a fix between rounds,
    // so the head changes. This must not be branded a flake.
    recordRound(stmts, 'r4', 1, [{ jobId: 'backend', state: 'failed', head: 'h1' }]);
    recordRunTestHistory(
      { stmts, now: () => 100 },
      { runId: 'r4', projectId: 'proj', branch: 'feat', headSha: 'h1' },
    );
    recordRound(stmts, 'r4', 2, [{ jobId: 'backend', state: 'passed', head: 'h2' }]);
    recordRunTestHistory(
      { stmts, now: () => 200 },
      { runId: 'r4', projectId: 'proj', branch: 'feat', headSha: 'h2' },
    );
    const row = db
      .prepare('SELECT final_state, flaked FROM finalize_test_history WHERE run_id = ?')
      .get('r4') as { final_state: string; flaked: number };
    expect(row).toMatchObject({ final_state: 'passed', flaked: 0 });
  });

  it('records a never-recovered failure as failed + not flaked', () => {
    recordRound(stmts, 'r2', 1, [{ jobId: 'backend', state: 'failed', head: 'h1' }]);
    recordRunTestHistory(
      { stmts, now: () => 100 },
      { runId: 'r2', projectId: 'proj', branch: 'feat', headSha: 'h1' },
    );
    const row = db
      .prepare('SELECT final_state, flaked FROM finalize_test_history WHERE run_id = ?')
      .get('r2') as { final_state: string; flaked: number };
    expect(row).toMatchObject({ final_state: 'failed', flaked: 0 });
  });

  it('window filter excludes rows older than `since`', () => {
    recordRound(stmts, 'r3', 1, [{ jobId: 'e2e', state: 'passed', head: 'h1' }]);
    recordRunTestHistory(
      { stmts, now: () => 50 },
      { runId: 'r3', projectId: 'proj', branch: 'feat', headSha: 'h1' },
    );
    const recent = stmts.listFinalizeTestHistoryForProject.all('proj', 100) as unknown[];
    expect(recent).toHaveLength(0);
    const all = stmts.listFinalizeTestHistoryForProject.all('proj', 0) as unknown[];
    expect(all).toHaveLength(1);
  });
});

describe('loadActiveQuarantine', () => {
  it('round-trips quarantine rows into entries the gate can use', () => {
    const { stmts } = makeDb();
    const now = 1_000_000;
    stmts.upsertFinalizeQuarantine.run(
      'q1',
      'proj',
      'e2e',
      '',
      'alice',
      'flaky login',
      now,
      now + 10 * 24 * 60 * 60 * 1000,
      'alice',
    );
    const entries = loadActiveQuarantine({ stmts }, 'proj');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ jobId: 'e2e', owner: 'alice', projectId: 'proj' });
    expect(isInstanceQuarantined(entries, 'e2e', '', now)).toBe(true);
    expect(isInstanceQuarantined(entries, 'e2e', '', now + 20 * 24 * 60 * 60 * 1000)).toBe(false);
  });

  it('upsert is idempotent per instance (UNIQUE on project+job+matrix)', () => {
    const { stmts } = makeDb();
    const now = 1_000_000;
    stmts.upsertFinalizeQuarantine.run(
      'q1',
      'proj',
      'e2e',
      '',
      'alice',
      'r1',
      now,
      now + 1000,
      null,
    );
    stmts.upsertFinalizeQuarantine.run('q2', 'proj', 'e2e', '', 'bob', 'r2', now, now + 2000, null);
    const entries = loadActiveQuarantine({ stmts }, 'proj');
    expect(entries).toHaveLength(1);
    expect(entries[0].owner).toBe('bob'); // updated in place
  });
});
