/**
 * Regression test for the 2026-07-29 production outage.
 *
 * `finalize_kickoff_claims.job_filter` was added to the `CREATE TABLE IF NOT
 * EXISTS` body in server/db.ts but never given an `ALTER TABLE` migration (its
 * sibling `finalize_runs.job_filter`, added in the same change, did get one).
 * `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table, so every
 * database created before the edit kept the narrower table.
 *
 * The drift was silent until a restart pulled an image whose `initDb` prepares
 * `insertFinalizeKickoffClaim` — better-sqlite3 validates column names at
 * prepare time, so the process threw before binding its HTTP listener,
 * crash-looped, and the load balancer served 502s for the whole deployment.
 *
 * Booting against a legacy database must therefore self-repair. This asserts
 * the generic behavior (server/schema-reconcile.ts), not a hand-written
 * per-column migration: any column present in a CREATE body but missing from
 * the live table gets added at boot.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';

/** `finalize_kickoff_claims` exactly as it existed on prod: no `job_filter`. */
const LEGACY_KICKOFF_CLAIMS_SCHEMA = `
  CREATE TABLE finalize_kickoff_claims (
    claim_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`;

describe('initDb against a database with schema drift', () => {
  it('boots and repairs a legacy finalize_kickoff_claims missing job_filter', async () => {
    const dataDir = process.env.AGENT_HUB_DATA_DIR;
    if (!dataDir) {
      throw new Error('expected AGENT_HUB_DATA_DIR to be set by test/setup.ts');
    }

    const dbPath = path.join(dataDir, 'agent-hub.db');
    const seed = new Database(dbPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(LEGACY_KICKOFF_CLAIMS_SCHEMA);
    seed
      .prepare(
        `INSERT INTO finalize_kickoff_claims (claim_key, session_id, branch, mode, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('legacy-claim', 'session-1', 'main', 'full', 1_700_000_000);
    seed.close();

    // Before the fix this import threw:
    //   SqliteError: table finalize_kickoff_claims has no column named job_filter
    await expect(import('../db.js')).resolves.toBeDefined();

    const verify = new Database(dbPath, { readonly: true });
    const columns = (
      verify.pragma('table_info(finalize_kickoff_claims)') as { name: string }[]
    ).map((c) => c.name);
    expect(columns).toContain('job_filter');

    // Repair is additive: the pre-existing row survives, with NULL for the
    // column that did not exist when it was written.
    expect(
      verify
        .prepare(
          'SELECT claim_key, mode, job_filter FROM finalize_kickoff_claims WHERE claim_key = ?',
        )
        .get('legacy-claim'),
    ).toEqual({ claim_key: 'legacy-claim', mode: 'full', job_filter: null });
    verify.close();
  });
});
