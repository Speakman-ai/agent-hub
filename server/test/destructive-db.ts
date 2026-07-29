/**
 * The ONLY sanctioned way for a test to bulk-wipe tables or open a database
 * file it intends to write to.
 *
 * Every `db.exec('DELETE FROM <table>;')`-style cleanup must go through
 * `wipeTables`, which first proves the handle points at a scratch database
 * (in-memory, or a file under os.tmpdir()). A raw unqualified DELETE in a
 * beforeEach is exactly what wiped production kanban/support/deployment
 * data on 2026-07-01 when a test run escaped its tmpdir isolation.
 *
 * `openScratchDb` extends the same proof to the other direction: a test that
 * builds its own fixture database via `new Database(<path>)` and then runs
 * DDL. The path usually comes from `AGENT_HUB_DATA_DIR`, which the server
 * exports to every process it spawns — so in a session container it points at
 * the live production data dir, and a fixture `CREATE TABLE` lands on prod.
 *
 * This is deliberately independent of server/test/setup.ts: even if the
 * setup file never loads (broken config resolution, direct file run), the
 * wipe or the open still refuses a non-scratch target.
 */
import Database from 'better-sqlite3';
import type DatabaseType from 'better-sqlite3';
import { assertScratchDbFile } from '../db-safety.js';

/** Throw unless the open handle is backed by an in-memory or tmpdir file. */
export function assertScratchDb(db: DatabaseType.Database): void {
  // better-sqlite3 exposes the backing file path as `name`
  // ('' or ':memory:' for in-memory databases).
  assertScratchDbFile(db.name);
}

/**
 * Open a SQLite file for writing after proving it is a scratch path.
 *
 * Use this instead of a bare `new Database(dbPath)` anywhere a test seeds
 * fixture schema or rows, so the write target is validated before the handle
 * exists rather than after the DDL has already run.
 */
export function openScratchDb(
  dbPath: string,
  options?: DatabaseType.Options,
): DatabaseType.Database {
  assertScratchDbFile(dbPath);
  return new Database(dbPath, options);
}

/**
 * Delete all rows from the given tables, in order, after proving the
 * database is a scratch DB. Order matters when FK enforcement is on —
 * list children before parents.
 */
export function wipeTables(db: DatabaseType.Database, tables: readonly string[]): void {
  assertScratchDb(db);
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      throw new Error(`[destructive-db] invalid table name: ${JSON.stringify(table)}`);
    }
    db.exec(`DELETE FROM ${table};`);
  }
}
