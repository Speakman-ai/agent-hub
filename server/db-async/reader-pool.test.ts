import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AsyncDbReaderPool,
  AsyncDbError,
  AsyncDbTimeoutError,
  AsyncDbQueueFullError,
  AsyncDbClosedError,
} from './reader-pool.js';

interface Row {
  id: number;
  name: string;
}

let tmpDir: string;
let dbPath: string;
const pools: AsyncDbReaderPool[] = [];

function makePool(
  overrides: Partial<{ size: number; queryTimeoutMs: number; maxQueueDepth: number }> = {},
) {
  const pool = new AsyncDbReaderPool({
    dbPath,
    size: overrides.size ?? 2,
    queryTimeoutMs: overrides.queryTimeoutMs ?? 5_000,
    maxQueueDepth: overrides.maxQueueDepth ?? 1_000,
    busyTimeoutMs: 0,
  });
  pools.push(pool);
  return pool;
}

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'db-async-test-'));
  dbPath = path.join(tmpDir, 'test.db');
  const seed = new Database(dbPath);
  seed.pragma('journal_mode = WAL');
  seed.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  const insert = seed.prepare('INSERT INTO items (id, name) VALUES (?, ?)');
  for (let i = 1; i <= 5; i++) insert.run(i, `item-${i}`);
  // Close so WAL is checkpointed and the read-only connections see committed data.
  seed.close();
});

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.shutdown().catch(() => {})));
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('AsyncDbReaderPool — protocol round-trip', () => {
  it('all() returns every row; get() returns the first row', async () => {
    const pool = makePool();
    await pool.ready();

    const rows = await pool.all<Row>('SELECT id, name FROM items ORDER BY id');
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ id: 1, name: 'item-1' });
    expect(rows[4]).toEqual({ id: 5, name: 'item-5' });

    const one = await pool.get<Row>('SELECT id, name FROM items WHERE id = ?', [3]);
    expect(one).toEqual({ id: 3, name: 'item-3' });
  });

  it('get() resolves undefined when no row matches', async () => {
    const pool = makePool();
    const missing = await pool.get<Row>('SELECT id, name FROM items WHERE id = ?', [999]);
    expect(missing).toBeUndefined();
  });

  it('bind parameters are passed through to the worker', async () => {
    const pool = makePool();
    const rows = await pool.all<Row>('SELECT id, name FROM items WHERE id IN (?, ?)', [2, 4]);
    expect(rows.map((r) => r.id)).toEqual([2, 4]);
  });

  it('spreads load across multiple concurrent queries', async () => {
    const pool = makePool({ size: 3 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => pool.all<Row>('SELECT id FROM items ORDER BY id')),
    );
    for (const r of results) expect(r).toHaveLength(5);
  });
});

describe('AsyncDbReaderPool — error propagation', () => {
  it('surfaces SqliteError name + code + message', async () => {
    const pool = makePool();
    await expect(pool.all('SELECT * FROM does_not_exist')).rejects.toMatchObject({
      name: 'SqliteError',
      code: 'SQLITE_ERROR',
    });
    await pool.all('SELECT * FROM does_not_exist').catch((err: AsyncDbError) => {
      expect(err).toBeInstanceOf(AsyncDbError);
      expect(err.message).toContain('no such table');
    });
  });

  it('a failing query does not poison the worker for later queries', async () => {
    const pool = makePool({ size: 1 });
    await expect(pool.all('SELECT bogus FROM items')).rejects.toBeInstanceOf(AsyncDbError);
    const rows = await pool.all<Row>('SELECT id FROM items');
    expect(rows).toHaveLength(5);
  });
});

describe('AsyncDbReaderPool — readonly enforcement', () => {
  it('rejects a write statement with ASYNC_DB_READONLY', async () => {
    const pool = makePool();
    await expect(pool.all("INSERT INTO items (id, name) VALUES (6, 'x')")).rejects.toMatchObject({
      code: 'ASYNC_DB_READONLY',
    });
    await expect(
      pool.all('UPDATE items SET name = ? WHERE id = ?', ['y', 1]),
    ).rejects.toMatchObject({ code: 'ASYNC_DB_READONLY' });
    await expect(pool.all('DELETE FROM items WHERE id = 1')).rejects.toMatchObject({
      code: 'ASYNC_DB_READONLY',
    });
  });

  it('rejects INSERT ... RETURNING even though it returns rows', async () => {
    const pool = makePool();
    await expect(
      pool.all("INSERT INTO items (id, name) VALUES (7, 'z') RETURNING id"),
    ).rejects.toMatchObject({ code: 'ASYNC_DB_READONLY' });
  });

  it('the database is not mutated by a rejected write', async () => {
    const pool = makePool();
    await pool.all("INSERT INTO items (id, name) VALUES (6, 'x')").catch(() => {});
    const verify = new Database(dbPath, { readonly: true });
    const count = verify.prepare('SELECT COUNT(*) AS c FROM items').get() as { c: number };
    verify.close();
    expect(count.c).toBe(5);
  });
});

describe('AsyncDbReaderPool — backpressure', () => {
  it('rejects new queries when the wait queue is full', async () => {
    const pool = makePool({ size: 1, maxQueueDepth: 2 });
    await pool.ready();
    // size 1 + maxQueueDepth 2 → at most 1 running + 2 queued accepted; the rest reject.
    const settlements = await Promise.allSettled(
      Array.from({ length: 12 }, () => pool.all('SELECT id FROM items')),
    );
    const rejected = settlements.filter((s) => s.status === 'rejected');
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(AsyncDbQueueFullError);
    }
    // Accepted queries still resolve correctly.
    const ok = settlements.filter((s) => s.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);
  });
});

describe('AsyncDbReaderPool — timeout + recycle', () => {
  it('rejects a runaway query and keeps serving after recycling the worker', async () => {
    const pool = makePool({ size: 1, queryTimeoutMs: 100 });
    await pool.ready();
    const spin =
      'WITH RECURSIVE r(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM r WHERE x < 1000000000) SELECT COUNT(*) AS c FROM r';
    await expect(pool.all(spin)).rejects.toBeInstanceOf(AsyncDbTimeoutError);
    // Worker was terminated + replaced; a normal query must still succeed.
    const rows = await pool.all<Row>('SELECT id FROM items');
    expect(rows).toHaveLength(5);
  }, 15_000);
});

describe('AsyncDbReaderPool — shutdown', () => {
  it('drains in-flight queries then rejects further submissions', async () => {
    const pool = makePool({ size: 2 });
    await pool.ready();
    const inFlight = Array.from({ length: 6 }, () => pool.all<Row>('SELECT id FROM items'));
    const shutdown = pool.shutdown();
    // Already-submitted queries drain to completion.
    const results = await Promise.all(inFlight);
    for (const r of results) expect(r).toHaveLength(5);
    await shutdown;
    expect(pool.stats().closed).toBe(true);
    // New submissions after shutdown are rejected.
    await expect(pool.all('SELECT id FROM items')).rejects.toBeInstanceOf(AsyncDbClosedError);
  });

  it('shutdown() is idempotent', async () => {
    const pool = makePool();
    await pool.ready();
    await Promise.all([pool.shutdown(), pool.shutdown()]);
    expect(pool.stats().closed).toBe(true);
  });
});
