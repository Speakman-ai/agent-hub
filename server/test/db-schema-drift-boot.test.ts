/**
 * Regression test for the 2026-07-29 production outage.
 *
 * A column was added to a `CREATE TABLE IF NOT EXISTS` body in server/db.ts but
 * never given an `ALTER TABLE` migration. `CREATE TABLE IF NOT EXISTS` is a
 * no-op against an existing table, so every database created before the edit
 * kept the narrower table.
 *
 * The drift was silent until a restart pulled an image whose `initDb` prepares a
 * statement naming the column — better-sqlite3 validates column names at prepare
 * time, so the process threw before binding its HTTP listener, crash-looped, and
 * the load balancer served 502s for the whole deployment.
 *
 * Booting against a legacy database must therefore self-repair. This asserts the
 * generic behavior (server/schema-reconcile.ts), not a hand-written per-column
 * migration: any column present in a CREATE body but missing from the live table
 * gets added at boot.
 *
 * `finalize_runs.pr_url` is the column under test because it is in the CREATE
 * body with no hand-written `ALTER TABLE` of its own, so the reconciler is the
 * only thing that can repair it — the same setup that produced the outage. (The
 * original incident column, `finalize_kickoff_claims.job_filter`, was deleted
 * when ci.yaml v1 support was removed.)
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { openScratchDb } from './destructive-db.js';

/** `finalize_runs` as a pre-`pr_url` install has it: every other column, no `pr_url`. */
const LEGACY_FINALIZE_RUNS_SCHEMA = `
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
    ended_at INTEGER
  );
`;

describe('initDb against a database with schema drift', () => {
  it('boots and repairs a legacy finalize_runs missing pr_url', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    // Seeding writes the legacy production schema, so the target is proven to
    // be a scratch path before the handle opens — `AGENT_HUB_DATA_DIR` is the
    // live data dir in any process the server spawned.
    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = openScratchDb(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(LEGACY_FINALIZE_RUNS_SCHEMA);
    seed
      .prepare(
        `INSERT INTO finalize_runs (
           id, card_id, session_id, project_id, branch, head_sha, idempotency_key,
           status, trigger_source, triggered_by_user_id, author_name, author_email,
           started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-run',
        'card-1',
        'session-1',
        'proj-1',
        'main',
        'abc123',
        'idem-legacy',
        'pushed',
        'ui_button',
        'user-1',
        'Test User',
        'test@example.com',
        1_700_000_000,
      );
    seed.close();

    // Before the reconciler this import threw:
    //   SqliteError: table finalize_runs has no column named pr_url
    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });
    const columns = (verify.pragma('table_info(finalize_runs)') as { name: string }[]).map(
      (c) => c.name,
    );
    expect(columns).toContain('pr_url');

    // Repair is additive: the pre-existing row survives, with NULL for the
    // column that did not exist when it was written.
    expect(
      verify.prepare('SELECT id, status, pr_url FROM finalize_runs WHERE id = ?').get('legacy-run'),
    ).toEqual({ id: 'legacy-run', status: 'pushed', pr_url: null });
    verify.close();
  });
});
