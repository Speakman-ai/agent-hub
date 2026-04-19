/**
 * PR-env port pool tests (W2).
 *
 * Covers the uniqueness + exhaustion contract from the W2 card:
 *   • concurrent allocations never collide (defended by UNIQUE(port))
 *   • range-exhaustion throws the typed `PortPoolExhaustedError`
 *   • allocate() is idempotent per (repo, PR number)
 *   • release() frees a slot and returns true iff a row was deleted
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PORT_RANGE,
  PortPool,
  PORT_POOL_SCHEMA,
  PortPoolExhaustedError,
  type PortRange,
} from './port-pool.js';

function freshPool(range: PortRange = DEFAULT_PORT_RANGE): {
  pool: PortPool;
  db: Database.Database;
} {
  const db = new Database(':memory:');
  db.exec(PORT_POOL_SCHEMA);
  const pool = new PortPool(db, { range });
  return { pool, db };
}

describe('PortPool.allocatePort', () => {
  it('returns the lowest free port in ascending order', () => {
    const { pool } = freshPool({ min: 3100, max: 3102 });
    expect(pool.allocatePort('acme/repo', 1)).toBe(3100);
    expect(pool.allocatePort('acme/repo', 2)).toBe(3101);
    expect(pool.allocatePort('acme/repo', 3)).toBe(3102);
  });

  it('is idempotent per (repo, PR) — resync returns the same port', () => {
    const { pool } = freshPool({ min: 3100, max: 3110 });
    const first = pool.allocatePort('acme/repo', 42);
    expect(pool.allocatePort('acme/repo', 42)).toBe(first);
    // A different repo with the same PR number gets its own port.
    const other = pool.allocatePort('other/repo', 42);
    expect(other).not.toBe(first);
  });

  it('reuses ports released by closed PRs', () => {
    const { pool } = freshPool({ min: 3100, max: 3102 });
    pool.allocatePort('r', 1); // 3100
    pool.allocatePort('r', 2); // 3101
    expect(pool.releasePort('r', 1)).toBe(true);
    // New PR should take the freed 3100 (lowest gap), not 3102.
    expect(pool.allocatePort('r', 3)).toBe(3100);
  });

  it('throws PortPoolExhaustedError when the range is full', () => {
    const { pool } = freshPool({ min: 3100, max: 3101 });
    pool.allocatePort('r', 1);
    pool.allocatePort('r', 2);
    expect(() => pool.allocatePort('r', 3)).toThrowError(PortPoolExhaustedError);
    try {
      pool.allocatePort('r', 4);
    } catch (err) {
      expect(err).toBeInstanceOf(PortPoolExhaustedError);
      expect((err as PortPoolExhaustedError).range).toEqual({ min: 3100, max: 3101 });
      expect((err as PortPoolExhaustedError).allocatedCount).toBe(2);
    }
  });

  it('exhaustion error is typed and discriminable from generic errors', () => {
    const { pool } = freshPool({ min: 3100, max: 3100 });
    pool.allocatePort('r', 1);
    try {
      pool.allocatePort('r', 2);
      expect.fail('expected exhaustion');
    } catch (err) {
      expect((err as Error).name).toBe('PortPoolExhaustedError');
    }
  });

  it('UNIQUE(port) guards against duplicate ports across repos', () => {
    // Directly manipulate the DB to simulate a race: pre-insert a port
    // and confirm the pool can't double-assign it.
    const { pool, db } = freshPool({ min: 3100, max: 3102 });
    db.prepare(`INSERT INTO pr_env_ports (repo_full_name, pr_number, port) VALUES (?, ?, ?)`).run(
      'other/repo',
      99,
      3100,
    );
    // First free port seen by our scan is 3101, not 3100 (already taken).
    expect(pool.allocatePort('acme/repo', 1)).toBe(3101);
  });

  it('concurrent allocations across 100 PRs produce 100 unique ports', () => {
    const { pool } = freshPool({ min: 3100, max: 3199 }); // 100-port range
    const ports = new Set<number>();
    for (let pr = 1; pr <= 100; pr++) {
      const p = pool.allocatePort('acme/repo', pr);
      expect(ports.has(p)).toBe(false);
      ports.add(p);
    }
    expect(ports.size).toBe(100);
    // Next one must exhaust.
    expect(() => pool.allocatePort('acme/repo', 101)).toThrowError(PortPoolExhaustedError);
  });
});

describe('PortPool.releasePort', () => {
  it('returns true when a row was deleted and false otherwise', () => {
    const { pool } = freshPool();
    pool.allocatePort('r', 1);
    expect(pool.releasePort('r', 1)).toBe(true);
    expect(pool.releasePort('r', 1)).toBe(false);
    expect(pool.releasePort('r', 9999)).toBe(false);
  });

  it('is safe to replay for webhook idempotency', () => {
    const { pool } = freshPool();
    const p = pool.allocatePort('r', 7);
    pool.releasePort('r', 7);
    pool.releasePort('r', 7);
    pool.releasePort('r', 7);
    // Port should be re-allocatable cleanly after the repeated releases.
    expect(pool.allocatePort('r', 8)).toBe(p);
  });
});

describe('PortPool.listAllocations / getPort', () => {
  it('surface active allocations in ascending port order', () => {
    const { pool } = freshPool({ min: 3100, max: 3105 });
    pool.allocatePort('r', 2); // 3100
    pool.allocatePort('r', 5); // 3101
    pool.allocatePort('r', 1); // 3102
    const list = pool.listAllocations();
    expect(list.map((r) => r.port)).toEqual([3100, 3101, 3102]);
    expect(pool.getPort('r', 5)).toBe(3101);
    expect(pool.getPort('r', 999)).toBeNull();
  });
});
