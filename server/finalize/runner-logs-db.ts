/**
 * runner-logs-db.ts — dedicated SQLite store for the `runner_job_logs` spool.
 *
 * `runner_job_logs` is the hot-write flood table of the runner control plane:
 * remote Finalize agents append CI stdout/stderr frames at up to ~1M rows/day.
 * It used to live in the shared cross-org `orgs.db` alongside the runner queue,
 * users, auth, and every other control-plane table — so a WAL checkpoint or a
 * write burst on the spool synchronously stalled unrelated `orgs.db` requests
 * (the 1.5 GB orgs.db / 147 MB WAL incident).
 *
 * Per spec `hot-write-isolation`, the spool moves into its own DB file with its
 * own connection + WAL. A checkpoint on this file no longer blocks a request
 * reading/writing `orgs.db`, and the file stays small because the Phase-1 reaper
 * bounds it. The runner *queue* tables (`runner_jobs`, `runner_agents`) stay in
 * `orgs.db` — they are low-churn control state, and the step-output read path
 * still resolves a queue-job id there before reading frames here (two separate
 * queries, never a cross-file JOIN).
 *
 * Pure leaf-ish module: imports only better-sqlite3 + node stdlib so `orgs.ts`
 * can wire it in without an import cycle.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { mkdirSync } from 'fs';
import { registerCheckpointDb, unregisterCheckpointDb } from '../db-checkpoint.js';

/** Checkpoint-registry label for `runner-logs.db` (shared with the WAL-pressure gate). */
export const RUNNER_JOB_LOGS_CHECKPOINT_LABEL = 'runner-logs.db';

/**
 * DDL for the isolated spool. Identical shape to the table that previously
 * lived in `RUNNER_QUEUE_SCHEMA` (orgs.db) so migrated rows drop straight in.
 */
export const RUNNER_JOB_LOGS_SCHEMA = `
CREATE TABLE IF NOT EXISTS runner_job_logs (
  job_id     TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  step_index INTEGER NOT NULL,
  stream     TEXT NOT NULL,                  -- stdout|stderr
  data       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_runner_job_logs_at ON runner_job_logs(at);
`;

/** Default filename beside `orgs.db` in the data dir. */
export const RUNNER_LOGS_DB_FILENAME = 'runner-logs.db';

let logsDb: Database.Database | null = null;
let logsDbPath: string | null = null;

/**
 * Override the `runner-logs.db` location — for tests only. Pass `null` to reset
 * back to the default (`<dir>/runner-logs.db`, where `<dir>` is passed to
 * {@link initRunnerJobLogsDb}). Closes any open handle so the next init is clean.
 */
let logsDbPathOverride: string | null = null;
export function setRunnerJobLogsDbPathForTests(p: string | null): void {
  logsDbPathOverride = p;
  closeRunnerJobLogsDb();
}

/** Close the handle (test teardown / re-init). Safe to call when not open. */
export function closeRunnerJobLogsDb(): void {
  if (logsDb) {
    try {
      unregisterCheckpointDb(logsDb);
    } catch {}
    try {
      logsDb.close();
    } catch {}
    logsDb = null;
    logsDbPath = null;
  }
}

/**
 * Accessor for the dedicated `runner_job_logs` handle. Throws if
 * {@link initRunnerJobLogsDb} hasn't run — callers are always downstream of
 * server startup (or a test's `initOrgsDb()`).
 */
export function getRunnerJobLogsDb(): Database.Database {
  if (!logsDb) {
    throw new Error('runner-logs.db not initialized — call initRunnerJobLogsDb() first');
  }
  return logsDb;
}

/** Resolve the on-disk path for the spool given the data dir (honours override). */
export function resolveRunnerJobLogsDbPath(dir: string): string {
  return logsDbPathOverride || path.join(dir, RUNNER_LOGS_DB_FILENAME);
}

/**
 * Open (or re-open) the dedicated spool DB in `dir` (the same data dir that
 * holds `orgs.db`). Idempotent: closes any prior handle first, so tests that
 * re-init against a fresh tmp dir don't leak connections.
 */
export function initRunnerJobLogsDb(dir: string): void {
  closeRunnerJobLogsDb();
  const dbPath = resolveRunnerJobLogsDbPath(dir);
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  // Hot-write table with a concurrent reader (step-output) + the migration's
  // cross-connection ATTACH write; a short busy wait avoids spurious
  // `SQLITE_BUSY` under that light contention.
  db.pragma('busy_timeout = 5000');
  // Bound WAL cadence + enroll in the background checkpoint sweep so this
  // hot-write spool's checkpoints stay small (see server/db-checkpoint.ts).
  registerCheckpointDb(db, RUNNER_JOB_LOGS_CHECKPOINT_LABEL);
  db.exec(RUNNER_JOB_LOGS_SCHEMA);
  logsDb = db;
  logsDbPath = dbPath;
}

/**
 * One-time migration off the legacy `orgs.db` spool. Runs on the *orgs.db*
 * connection (the native owner, so the `DROP TABLE` never fights a
 * cross-connection lock): if a legacy `runner_job_logs` table still exists
 * there, ATTACH the dedicated file, copy the rows in, then drop the legacy
 * table so `orgs.db` stops carrying (and checkpointing) the spool.
 *
 * Fresh installs are a no-op: `RUNNER_QUEUE_SCHEMA` no longer creates the table,
 * so `main.runner_job_logs` won't exist. Best-effort by design — a copy failure
 * still drops the legacy table (documented clean cutover: the frames are
 * transient CI stdout, aggressively reaped, never read post-run), so `orgs.db`
 * is guaranteed lean afterward and never keeps an orphaned flood table.
 *
 * Must be called AFTER {@link initRunnerJobLogsDb} (the destination table has to
 * exist to receive rows).
 */
export function migrateLegacyRunnerJobLogsFromOrgsDb(orgsDb: Database.Database): void {
  const dest = logsDbPath;
  if (!dest) return; // logs DB not initialized — nothing to migrate into.

  const legacy = orgsDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='runner_job_logs'`)
    .get() as { name?: string } | undefined;
  if (!legacy) return;

  // SQLite string-literal escaping for the ATTACH path (single quotes doubled).
  const attachPath = dest.replace(/'/g, "''");
  try {
    orgsDb.exec(`ATTACH DATABASE '${attachPath}' AS rlogs`);
    try {
      orgsDb.exec(
        `INSERT OR IGNORE INTO rlogs.runner_job_logs (job_id, seq, step_index, stream, data, at)
           SELECT job_id, seq, step_index, stream, data, at FROM main.runner_job_logs`,
      );
    } catch {
      // Copy failed (corrupt legacy rows, disk pressure, …). Fall through to the
      // clean cutover below rather than leaving an orphaned flood table behind.
    }
    orgsDb.exec(`DROP TABLE IF EXISTS main.runner_job_logs`);
    orgsDb.exec(`DETACH DATABASE rlogs`);
  } catch {
    // ATTACH/DETACH failed entirely — best-effort. Make sure we still detach so a
    // half-open attachment can't wedge later statements on this connection.
    try {
      orgsDb.exec(`DETACH DATABASE rlogs`);
    } catch {}
  }
}
