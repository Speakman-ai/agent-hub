/**
 * Regression test for the `job_filter` column-drop migration in `server/db.ts`.
 *
 * `finalize_runs.job_filter` and `finalize_kickoff_claims.job_filter` backed the
 * retired single-job "Run Tests" dropdown. Nothing writes them any more and the
 * per-phase pickers no longer read them, so boot drops the column wherever an
 * older install still carries it.
 *
 * Three behaviours need locking:
 *
 *   1. An install that predates the drop (column present, rows populated) has
 *      the column removed while every other value on the row survives.
 *   2. Historical job-filtered rows get `validated_head_sha` cleared BEFORE the
 *      drop. The `job_filter IS NULL` clause in `getLatestChecksRunForSession`
 *      used to keep a partial run from standing in as the checks half of a
 *      "branch fully validated" pair; without the column, clearing the sha is
 *      what keeps that true.
 *   3. The migration is idempotent — a second `db.ts` load against the
 *      post-migration schema is a no-op, not a "no such column" throw.
 *
 * Test approach mirrors `db-backlog-drop-migration.test.ts`: seed the
 * pre-migration schema on disk BEFORE importing `db.ts`, import (which runs the
 * boot-time migration), then assert via a fresh read-only connection.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

function seedPreMigrationSchema(dbPath: string): void {
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  // The pre-migration shape: today's `finalize_runs` DDL plus the trailing
  // `job_filter` column. `db.ts` runs CREATE TABLE IF NOT EXISTS on top (a
  // no-op for an existing table) before the migration body, so the seeded
  // shape is what the migration actually sees.
  seed.exec(`
    CREATE TABLE finalize_runs (
      id TEXT PRIMARY KEY,
      card_id TEXT NOT NULL,
      session_id TEXT,
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_sha TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT,
      trigger_source TEXT NOT NULL,
      worktree_path TEXT,
      triggered_by_user_id TEXT NOT NULL,
      author_name TEXT NOT NULL,
      author_email TEXT NOT NULL,
      reviewer_verdict TEXT,
      failure_reason TEXT,
      failed_step_index INTEGER,
      failed_step_name TEXT,
      failed_step_exit_code INTEGER,
      retry_of_run_id TEXT,
      active_seconds_consumed INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      pr_url TEXT,
      validated_head_sha TEXT,
      mode TEXT NOT NULL DEFAULT 'full',
      job_filter TEXT
    );
    CREATE TABLE finalize_kickoff_claims (
      claim_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      mode TEXT NOT NULL,
      job_filter TEXT,
      created_at INTEGER NOT NULL
    );
  `);

  seed
    .prepare(
      `INSERT INTO finalize_runs (
         id, card_id, session_id, project_id, branch, head_sha, idempotency_key,
         status, phase, trigger_source, triggered_by_user_id, author_name,
         author_email, started_at, mode, validated_head_sha, job_filter
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    // A historical job-filtered debug run: the exact row shape the column existed for.
    .run(
      'run-filtered',
      'card-1',
      'sess-1',
      'proj-1',
      'feature/x',
      'abc123',
      'idem-filtered',
      'pushed',
      'push',
      'ui_button',
      'user-1',
      'Test User',
      'test@example.com',
      1_000,
      'checks',
      'abc123', // the lie this migration clears: a partial run validated nothing
      '["e2e"]',
    );
  seed
    .prepare(
      `INSERT INTO finalize_runs (
         id, card_id, session_id, project_id, branch, head_sha, idempotency_key,
         status, phase, trigger_source, triggered_by_user_id, author_name,
         author_email, started_at, mode, validated_head_sha, job_filter
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'run-full',
      'card-1',
      'sess-1',
      'proj-1',
      'feature/x',
      'def456',
      'idem-full',
      'pushed',
      'push',
      'ui_button',
      'user-1',
      'Test User',
      'test@example.com',
      2_000,
      'full',
      'def456',
      null,
    );
  seed
    .prepare(
      `INSERT INTO finalize_kickoff_claims (claim_key, session_id, branch, mode, job_filter, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('claim-1', 'sess-1', 'feature/x', 'checks', '["lint"]', 3_000);

  seed.close();
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
}

describe('finalize job_filter column-drop migration', () => {
  it('drops the column from both tables, preserves the rows, and is idempotent', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }
    const dbPath = path.join(dataDir, 'agent-hub.db');

    seedPreMigrationSchema(dbPath);

    // Module load triggers initDb(config.dataDir), which runs the migration.
    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });

    expect(columnNames(verify, 'finalize_runs')).not.toContain('job_filter');
    expect(columnNames(verify, 'finalize_kickoff_claims')).not.toContain('job_filter');

    // Dropping a column must not drop rows or disturb their other values —
    // including the historical job-filtered run, which stays readable history.
    const runs = verify
      .prepare(
        'SELECT id, mode, status, head_sha, validated_head_sha FROM finalize_runs ORDER BY started_at',
      )
      .all() as Array<{
      id: string;
      mode: string;
      status: string;
      head_sha: string;
      validated_head_sha: string | null;
    }>;
    expect(runs).toEqual([
      // The partial run keeps its identity and history, but no longer claims to
      // have validated a head — so it can never be picked as the checks sibling
      // that unlocks ready-to-push for that sha.
      {
        id: 'run-filtered',
        mode: 'checks',
        status: 'pushed',
        head_sha: 'abc123',
        validated_head_sha: null,
      },
      // The full run is untouched.
      {
        id: 'run-full',
        mode: 'full',
        status: 'pushed',
        head_sha: 'def456',
        validated_head_sha: 'def456',
      },
    ]);

    const claims = verify
      .prepare('SELECT claim_key, session_id, branch, mode FROM finalize_kickoff_claims')
      .all() as Array<{ claim_key: string; session_id: string; branch: string; mode: string }>;
    expect(claims).toEqual([
      { claim_key: 'claim-1', session_id: 'sess-1', branch: 'feature/x', mode: 'checks' },
    ]);

    verify.close();

    // Idempotency: re-running the migration body against the post-migration
    // schema must not throw "no such column".
    const rerun = new Database(dbPath);
    expect(() => {
      for (const table of ['finalize_runs', 'finalize_kickoff_claims']) {
        let present = true;
        try {
          rerun.prepare(`SELECT job_filter FROM ${table} LIMIT 1`).get();
        } catch {
          present = false;
        }
        if (present) rerun.exec(`ALTER TABLE ${table} DROP COLUMN job_filter`);
      }
    }).not.toThrow();
    rerun.close();
  });
});
