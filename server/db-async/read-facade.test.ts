import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncDbReaderPool } from './reader-pool.js';
import {
  poolReadFacade,
  syncReadFacade,
  getReadFacade,
  setReadFacadeForTesting,
  readAll,
  readGet,
  type AsyncReadFacade,
  type ReadableStatement,
} from './read-facade.js';

/**
 * The pool-backed facade forwards `stmt.source` to a real reader pool, so this
 * suite spins up a genuine worker pool against a temp DB to prove the whole
 * statement-source round-trip works off-thread. The route tests use the sync
 * facade instead (installed globally in server/test/setup.ts) to stay fast.
 */
let tmpDir: string;
let dbPath: string;
let mainDb: Database.Database;
const pools: AsyncDbReaderPool[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'read-facade-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  const seed = new Database(dbPath);
  seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT, label TEXT)');
  const ins = seed.prepare('INSERT INTO items (id, kind, label) VALUES (?, ?, ?)');
  ins.run(1, 'a', 'alpha');
  ins.run(2, 'a', 'beta');
  ins.run(3, 'b', 'gamma');
  seed.close();
  // Main-thread handle used to build the prepared statements the facade reads
  // `.source` from (mirrors how routes pass their existing `stmts` entries).
  mainDb = new Database(dbPath, { readonly: true });
});

afterEach(async () => {
  setReadFacadeForTesting(null);
  mainDb.close();
  for (const p of pools) await p.shutdown();
  pools.length = 0;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makePool(): AsyncDbReaderPool {
  const pool = new AsyncDbReaderPool({
    dbPath,
    size: 2,
    queryTimeoutMs: 5_000,
    maxQueueDepth: 100,
    busyTimeoutMs: 0,
  });
  pools.push(pool);
  return pool;
}

describe('poolReadFacade', () => {
  it('runs all() off-thread using the statement source, ordered', async () => {
    const pool = makePool();
    const stmt = mainDb.prepare(
      'SELECT id, label FROM items WHERE kind = ? ORDER BY id ASC',
    ) as unknown as ReadableStatement;
    const rows = await poolReadFacadeVia(pool).all<{ id: number; label: string }>(stmt, ['a']);
    expect(rows.map((r) => r.label)).toEqual(['alpha', 'beta']);
  });

  it('runs get() off-thread and returns undefined for no match', async () => {
    const pool = makePool();
    const facade = poolReadFacadeVia(pool);
    const stmt = mainDb.prepare(
      'SELECT id, label FROM items WHERE id = ?',
    ) as unknown as ReadableStatement;
    const row = await facade.get<{ id: number; label: string }>(stmt, [3]);
    expect(row?.label).toBe('gamma');
    const missing = await facade.get(stmt, [999]);
    expect(missing).toBeUndefined();
  });

  // Sanity: the exported default is wired to the shared pool. We don't spawn the
  // shared pool here (that reads config.dataDir) — just assert the shape.
  it('exports a default facade with all/get', () => {
    expect(typeof poolReadFacade.all).toBe('function');
    expect(typeof poolReadFacade.get).toBe('function');
  });
});

describe('syncReadFacade', () => {
  it('runs statements on the calling thread and resolves a promise', async () => {
    const stmt = mainDb.prepare(
      'SELECT id, label FROM items ORDER BY id ASC',
    ) as unknown as ReadableStatement;
    const rows = await syncReadFacade.all<{ id: number }>(stmt, []);
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3]);
    const one = await syncReadFacade.get<{ label: string }>(stmt, []);
    expect(one?.label).toBe('alpha');
  });
});

describe('facade override + convenience helpers', () => {
  it('getReadFacade returns the pool default until an override is set', () => {
    expect(getReadFacade()).toBe(poolReadFacade);
    setReadFacadeForTesting(syncReadFacade);
    expect(getReadFacade()).toBe(syncReadFacade);
    setReadFacadeForTesting(null);
    expect(getReadFacade()).toBe(poolReadFacade);
  });

  it('readAll / readGet route through the active facade', async () => {
    const calls: string[] = [];
    const spy: AsyncReadFacade = {
      all: (stmt, params = []) => {
        calls.push(`all:${stmt.source}:${JSON.stringify(params)}`);
        return Promise.resolve(stmt.all(...params) as never[]);
      },
      get: (stmt, params = []) => {
        calls.push(`get:${stmt.source}`);
        return Promise.resolve(stmt.get(...params) as never);
      },
    };
    setReadFacadeForTesting(spy);
    const stmt = mainDb.prepare(
      'SELECT id FROM items WHERE kind = ? ORDER BY id ASC',
    ) as unknown as ReadableStatement;
    const rows = await readAll<{ id: number }>(stmt, ['b']);
    expect(rows.map((r) => r.id)).toEqual([3]);
    await readGet(stmt, ['b']);
    expect(calls).toEqual([
      'all:SELECT id FROM items WHERE kind = ? ORDER BY id ASC:["b"]',
      'get:SELECT id FROM items WHERE kind = ? ORDER BY id ASC',
    ]);
  });
});

/** Build a pool-backed facade bound to a specific test pool. */
function poolReadFacadeVia(pool: AsyncDbReaderPool): AsyncReadFacade {
  return {
    all: (stmt, params = []) => pool.all(stmt.source, params),
    get: (stmt, params = []) => pool.get(stmt.source, params),
  };
}
