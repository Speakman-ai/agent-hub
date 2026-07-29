/**
 * Regression tests for the 2026-07-01 production kanban wipe.
 *
 * That incident: a vitest run inside the prod container inherited
 * AGENT_HUB_DATA_DIR=/data, never loaded vitest.config.ts/setup.ts isolation,
 * and its deploy-test beforeEach wiped every kanban board via unqualified
 * DELETEs. These tests pin the exact conditions of that failure and assert
 * the guards now fail closed.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdtempSync } from 'fs';
import Database from 'better-sqlite3';
import {
  isTestContext,
  isPathInside,
  isScratchPath,
  assertSafeTestDataDir,
  assertScratchDbFile,
  UnsafeTestDatabaseError,
} from './db-safety.js';
import { wipeTables, assertScratchDb, openScratchDb } from './test/destructive-db.js';

const PROD_LIKE_DIRS = [
  '/data',
  '/var/lib/agent-hub/data',
  path.join(os.homedir(), '.agent-hub', 'data'),
];

describe('isTestContext', () => {
  it('detects vitest worker env even when no config/setup file loaded', () => {
    expect(isTestContext({ VITEST: 'true' })).toBe(true);
    expect(isTestContext({ VITEST_WORKER_ID: '1' })).toBe(true);
    expect(isTestContext({ VITEST_POOL_ID: '2' })).toBe(true);
    expect(isTestContext({ NODE_ENV: 'test' })).toBe(true);
    expect(isTestContext({ AGENT_HUB_TEST_MODE: '1' })).toBe(true);
  });

  it('is false for a production-shaped environment', () => {
    expect(isTestContext({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestContext({})).toBe(false);
  });

  it('is true in this very process (vitest sets its own env)', () => {
    expect(isTestContext()).toBe(true);
  });
});

describe('isPathInside / isScratchPath', () => {
  it('accepts tmpdir descendants and in-memory markers', () => {
    expect(isScratchPath(path.join(os.tmpdir(), 'agent-hub-test-x', 'agent-hub.db'))).toBe(true);
    expect(isScratchPath(os.tmpdir())).toBe(true);
    expect(isScratchPath(':memory:')).toBe(true);
    expect(isScratchPath('')).toBe(true);
  });

  it('rejects prod-like paths and tmpdir-prefix lookalikes', () => {
    for (const dir of PROD_LIKE_DIRS) expect(isScratchPath(dir)).toBe(false);
    // '/tmpfoo' must not pass a naive startsWith('/tmp') check
    expect(isPathInside(`${os.tmpdir()}foo`, os.tmpdir())).toBe(false);
    // traversal back out of tmpdir must not pass
    expect(isScratchPath(path.join(os.tmpdir(), '..', 'data'))).toBe(
      path.dirname(os.tmpdir()) === os.tmpdir(), // false everywhere real
    );
  });
});

describe('assertSafeTestDataDir — the 2026-07-01 incident shape', () => {
  it('throws for an inherited prod data dir under a vitest worker with NO test-mode env', () => {
    // Exactly the incident: VITEST set by the runner itself, AGENT_HUB_TEST_MODE
    // absent (config never loaded), data dir explicitly /data (not the default).
    expect(() => assertSafeTestDataDir('/data', { VITEST: 'true' })).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it('throws for the default prod dir under NODE_ENV=test', () => {
    expect(() =>
      assertSafeTestDataDir(path.join(os.homedir(), '.agent-hub', 'data'), { NODE_ENV: 'test' }),
    ).toThrow(UnsafeTestDatabaseError);
  });

  it('allows tmpdir data dirs in test context', () => {
    expect(() =>
      assertSafeTestDataDir(path.join(os.tmpdir(), 'agent-hub-test-1', 'file-x'), {
        VITEST: 'true',
      }),
    ).not.toThrow();
  });

  it('is a no-op outside test context (prod server boots normally)', () => {
    expect(() => assertSafeTestDataDir('/data', { NODE_ENV: 'production' })).not.toThrow();
    expect(() => assertSafeTestDataDir('/data', {})).not.toThrow();
  });

  it('honors the explicit escape hatch', () => {
    expect(() =>
      assertSafeTestDataDir('/data', { VITEST: 'true', AGENT_HUB_ALLOW_UNSAFE_TEST_DB: '1' }),
    ).not.toThrow();
  });
});

describe('assertScratchDbFile — destructive-statement gate', () => {
  it('throws for a prod-like file path regardless of env', () => {
    expect(() => assertScratchDbFile('/data/agent-hub.db', {})).toThrow(UnsafeTestDatabaseError);
    expect(() => assertScratchDbFile('/data/agent-hub.db', { NODE_ENV: 'production' })).toThrow(
      UnsafeTestDatabaseError,
    );
  });

  it('allows tmpdir files and in-memory databases', () => {
    expect(() => assertScratchDbFile(path.join(os.tmpdir(), 'x', 'agent-hub.db'))).not.toThrow();
    expect(() => assertScratchDbFile(':memory:')).not.toThrow();
  });
});

describe('wipeTables', () => {
  it('wipes tables on a scratch database', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'destructive-db-test-'));
    const db = new Database(path.join(dir, 'scratch.db'));
    db.exec('CREATE TABLE a (id INTEGER); CREATE TABLE b (id INTEGER);');
    db.exec('INSERT INTO a VALUES (1); INSERT INTO b VALUES (2);');
    wipeTables(db, ['a', 'b']);
    expect((db.prepare('SELECT count(*) n FROM a').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM b').get() as { n: number }).n).toBe(0);
    db.close();
  });

  it('works for in-memory databases', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER); INSERT INTO t VALUES (1);');
    expect(() => wipeTables(db, ['t'])).not.toThrow();
    db.close();
  });

  it('refuses a handle backed by a non-scratch file — without touching it', () => {
    // Simulate a handle onto a prod path; assertScratchDb only reads `.name`,
    // so a stub is safe and never opens the real file.
    const prodLike = { name: '/data/agent-hub.db' } as unknown as Database.Database;
    expect(() => assertScratchDb(prodLike)).toThrow(UnsafeTestDatabaseError);
    expect(() => wipeTables(prodLike, ['kanban_boards'])).toThrow(UnsafeTestDatabaseError);
  });

  it('rejects malformed table names (no SQL splicing)', () => {
    const db = new Database(':memory:');
    expect(() => wipeTables(db, ['kanban_boards; DROP TABLE x'])).toThrow(/invalid table name/);
    db.close();
  });
});

describe('openScratchDb', () => {
  it('opens a writable handle on a tmpdir path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'open-scratch-db-test-'));
    const db = openScratchDb(path.join(dir, 'fixture.db'));
    expect(() => db.exec('CREATE TABLE t (id INTEGER)')).not.toThrow();
    db.close();
  });

  it('refuses a prod-like path before the file is created', () => {
    // The seeding shape this guards: a fixture test joining a data dir it got
    // from AGENT_HUB_DATA_DIR, which is the live dir in any spawned process.
    //
    // Every probe deliberately sits under a directory component that cannot
    // exist, so removing the guard to check this test still fails makes
    // better-sqlite3 raise SQLITE_CANTOPEN — it can never reach a real
    // database file. `/data/agent-hub.db` IS the live database inside a
    // session container, and a bare `new Database` on it succeeds.
    for (const prodLike of PROD_LIKE_DIRS) {
      expect(() => openScratchDb(path.join(prodLike, 'no-such-dir', 'agent-hub.db'))).toThrow(
        UnsafeTestDatabaseError,
      );
    }
  });
});
