/**
 * runner-logs-db.test.ts — the dedicated `runner_job_logs` spool DB.
 *
 * Regression guard for spec hot-write-isolation: the spool must live in its own
 * SQLite file (own connection + WAL), writes must NOT land in the shared orgs.db
 * connection, reads must resolve from the new file, and a legacy install's rows
 * must migrate out of orgs.db on startup (leaving orgs.db lean).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { getRunnerJobLogsDb, RUNNER_LOGS_DB_FILENAME } from './runner-logs-db.js';
import { appendRunnerJobLog, runnerJobLogStats } from './runner-queue.js';

function orgsHasRunnerJobLogsTable(): boolean {
  return (
    getOrgsDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runner_job_logs'`)
      .get() !== undefined
  );
}

describe('runner-logs-db — dedicated spool file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runner-logs-db-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });

  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates runner-logs.db beside orgs.db as a distinct connection', () => {
    expect(existsSync(path.join(dir, RUNNER_LOGS_DB_FILENAME))).toBe(true);
    // Two different handles → a checkpoint on one cannot stall the other.
    expect(getRunnerJobLogsDb()).not.toBe(getOrgsDb());
  });

  it('runner_job_logs table lives only in the spool DB, never in orgs.db', () => {
    // orgs.db must not carry the flood table anymore.
    expect(orgsHasRunnerJobLogsTable()).toBe(false);
    // The spool DB has it.
    const inSpool = getRunnerJobLogsDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runner_job_logs'`)
      .get();
    expect(inSpool).toBeDefined();
  });

  it('appended frames write to the spool DB and are readable from it, not orgs.db', () => {
    appendRunnerJobLog({
      jobId: 'j1',
      seq: 0,
      stepIndex: 0,
      stream: 'stdout',
      data: 'hello',
      now: 5,
    });
    appendRunnerJobLog({
      jobId: 'j1',
      seq: 1,
      stepIndex: 0,
      stream: 'stderr',
      data: 'world',
      now: 6,
    });

    // Read resolves from the new file.
    const rows = getRunnerJobLogsDb()
      .prepare('SELECT data FROM runner_job_logs WHERE job_id=? ORDER BY seq')
      .all('j1') as Array<{ data: string }>;
    expect(rows.map((r) => r.data)).toEqual(['hello', 'world']);
    expect(runnerJobLogStats().rows).toBe(2);

    // The write never touched the orgs.db connection (table absent there).
    expect(orgsHasRunnerJobLogsTable()).toBe(false);
  });

  it('migrates legacy orgs.db rows into the spool DB and drops the legacy table', () => {
    // Simulate a pre-split install: close the live handles, seed a legacy
    // runner_job_logs table directly into orgs.db, then re-init so the
    // startup migration runs.
    setOrgsDbPathForTests(null);

    const orgsPath = path.join(dir, 'orgs.db');
    const seed = new Database(orgsPath);
    seed.pragma('journal_mode = WAL');
    seed.exec(`
      CREATE TABLE runner_job_logs (
        job_id TEXT NOT NULL, seq INTEGER NOT NULL, step_index INTEGER NOT NULL,
        stream TEXT NOT NULL, data TEXT NOT NULL, at INTEGER NOT NULL,
        PRIMARY KEY (job_id, seq)
      );
    `);
    const ins = seed.prepare(
      'INSERT INTO runner_job_logs (job_id, seq, step_index, stream, data, at) VALUES (?,?,?,?,?,?)',
    );
    ins.run('legacy', 0, 0, 'stdout', 'old-a', 100);
    ins.run('legacy', 1, 0, 'stderr', 'old-b', 101);
    seed.close();

    // Boot: initOrgsDb() opens the spool DB then migrates the legacy rows out.
    setOrgsDbPathForTests(orgsPath);
    initOrgsDb();

    // Rows moved to the spool DB.
    const migrated = getRunnerJobLogsDb()
      .prepare('SELECT data FROM runner_job_logs ORDER BY seq')
      .all() as Array<{ data: string }>;
    expect(migrated.map((r) => r.data)).toEqual(['old-a', 'old-b']);

    // Legacy table dropped from orgs.db (clean cutover — orgs.db stays lean).
    expect(orgsHasRunnerJobLogsTable()).toBe(false);
  });

  it('re-init is idempotent and does not throw on a fresh install (no legacy table)', () => {
    // No legacy table present after the beforeEach init; a second init must be a
    // clean no-op for the migration.
    expect(() => initOrgsDb()).not.toThrow();
    expect(orgsHasRunnerJobLogsTable()).toBe(false);
  });
});
