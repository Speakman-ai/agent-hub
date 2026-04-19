/**
 * Container pool schema tests.
 *
 * These apply POOL_SCHEMA to a fresh in-memory SQLite DB and assert the
 * shape, constraints, and indexes that the dispatcher / reaper / metrics
 * writer rely on. Running against :memory: keeps the tests hermetic — they
 * never touch the real agent-hub.db.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { POOL_SCHEMA } from './schema.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  return db;
}

type TableInfoRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type IndexListRow = { name: string; unique: number; origin: string };
type IndexInfoRow = { seqno: number; cid: number; name: string };

describe('container pool schema — creation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates pool_slots with the documented columns and PK', () => {
    const info = db.pragma('table_info(pool_slots)') as TableInfoRow[];
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      ['class', 'container_id', 'last_activity_at', 'slot_id', 'started_at', 'status'].sort(),
    );

    // slot_id is the primary key.
    expect(byName.slot_id.pk).toBe(1);
    // class and status are required; everything else nullable (so a free slot
    // can sit with no bound container).
    expect(byName.class.notnull).toBe(1);
    expect(byName.status.notnull).toBe(1);
    expect(byName.container_id.notnull).toBe(0);
    expect(byName.started_at.notnull).toBe(0);
    expect(byName.last_activity_at.notnull).toBe(0);
    // status defaults to 'free' so a freshly inserted row is usable.
    expect(byName.status.dflt_value).toContain('free');
  });

  it('creates pool_queue with priority_tier (pending enterprise opt-out)', () => {
    const info = db.pragma('table_info(pool_queue)') as TableInfoRow[];
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      ['class', 'enqueued_at', 'id', 'payload', 'priority_tier', 'status'].sort(),
    );
    expect(byName.id.pk).toBe(1);
    expect(byName.priority_tier.type.toUpperCase()).toBe('INTEGER');
    expect(byName.priority_tier.notnull).toBe(1);
    // Default priority_tier=0 keeps parity with the legacy single-tier queue
    // while the enterprise opt-out decision is outstanding.
    expect(byName.priority_tier.dflt_value).toBe('0');
    expect(byName.status.dflt_value).toContain('queued');
  });

  it('creates pool_metrics with a surrogate PK and required counters', () => {
    const info = db.pragma('table_info(pool_metrics)') as TableInfoRow[];
    const byName = Object.fromEntries(info.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(
      ['evictions', 'id', 'pool_util', 'queue_depth', 'reaps', 'timestamp'].sort(),
    );
    expect(byName.id.pk).toBe(1);
    expect(byName.pool_util.type.toUpperCase()).toBe('REAL');
    expect(byName.queue_depth.type.toUpperCase()).toBe('INTEGER');
    // evictions / reaps are per-sample counters, default 0 so the dispatcher
    // can omit them on quiet ticks.
    expect(byName.evictions.dflt_value).toBe('0');
    expect(byName.reaps.dflt_value).toBe('0');
  });

  it('is idempotent — re-applying the schema does not error', () => {
    expect(() => db.exec(POOL_SCHEMA)).not.toThrow();
  });
});

describe('container pool schema — unique constraints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('rejects duplicate slot_id in pool_slots (PRIMARY KEY)', () => {
    db.prepare('INSERT INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)').run(
      'pr-1',
      'pr_env',
      'free',
    );
    expect(() =>
      db
        .prepare('INSERT INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)')
        .run('pr-1', 'pr_env', 'free'),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it('rejects a container_id bound to two slots simultaneously', () => {
    const insert = db.prepare(
      'INSERT INTO pool_slots (slot_id, class, status, container_id) VALUES (?, ?, ?, ?)',
    );
    insert.run('pr-1', 'pr_env', 'busy', 'abc123');
    expect(() => insert.run('pr-2', 'pr_env', 'busy', 'abc123')).toThrow(
      /UNIQUE constraint failed/i,
    );
  });

  it('allows multiple free slots with NULL container_id', () => {
    // SQLite treats NULLs as distinct under UNIQUE, so several free slots
    // can coexist with no bound container — this is the common steady state.
    const insert = db.prepare(
      'INSERT INTO pool_slots (slot_id, class, status, container_id) VALUES (?, ?, ?, NULL)',
    );
    expect(() => {
      insert.run('pr-1', 'pr_env', 'free');
      insert.run('pr-2', 'pr_env', 'free');
      insert.run('pr-3', 'pr_env', 'free');
    }).not.toThrow();
    const rows = db.prepare('SELECT COUNT(*) as n FROM pool_slots').get() as { n: number };
    expect(rows.n).toBe(3);
  });

  it('rejects invalid class / status via CHECK constraints', () => {
    expect(() =>
      db
        .prepare('INSERT INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)')
        .run('x', 'bogus', 'free'),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db
        .prepare('INSERT INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)')
        .run('x', 'pr_env', 'bogus'),
    ).toThrow(/CHECK constraint failed/i);
    expect(() =>
      db
        .prepare('INSERT INTO pool_queue (id, class, payload) VALUES (?, ?, ?)')
        .run('q1', 'bogus', '{}'),
    ).toThrow(/CHECK constraint failed/i);
  });

  it('rejects duplicate queue ids', () => {
    const insert = db.prepare('INSERT INTO pool_queue (id, class, payload) VALUES (?, ?, ?)');
    insert.run('q1', 'pr_env', '{"pr":1}');
    expect(() => insert.run('q1', 'scaffold', '{"template":"next"}')).toThrow(
      /UNIQUE constraint failed/i,
    );
  });
});

describe('container pool schema — queue index', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  it('creates idx_pool_queue_status_enqueued_at on the expected columns', () => {
    const indexes = db.pragma('index_list(pool_queue)') as IndexListRow[];
    const target = indexes.find((i) => i.name === 'idx_pool_queue_status_enqueued_at');
    expect(target).toBeDefined();

    const cols = (db.pragma('index_info(idx_pool_queue_status_enqueued_at)') as IndexInfoRow[]).map(
      (c) => c.name,
    );
    // status must lead so equality filtering can satisfy the predicate without
    // scanning, then enqueued_at provides the ORDER BY for the dispatcher.
    expect(cols).toEqual(['status', 'enqueued_at']);
  });

  it('is used by the dispatcher hot-path query', () => {
    const plan = db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM pool_queue WHERE status = 'queued' ORDER BY enqueued_at ASC LIMIT 1",
      )
      .all() as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join('\n');
    expect(detail).toMatch(/idx_pool_queue_status_enqueued_at/);
  });

  it('creates idx_pool_metrics_timestamp for retention scans', () => {
    const indexes = db.pragma('index_list(pool_metrics)') as IndexListRow[];
    expect(indexes.some((i) => i.name === 'idx_pool_metrics_timestamp')).toBe(true);
  });
});

describe('container pool schema — happy-path inserts', () => {
  it('supports an end-to-end dequeue-and-bind round trip', () => {
    const db = freshDb();

    // Enqueue two PR env requests and one scaffold.
    const qIns = db.prepare(
      'INSERT INTO pool_queue (id, class, payload, priority_tier, enqueued_at) VALUES (?, ?, ?, ?, ?)',
    );
    qIns.run('q1', 'pr_env', '{"pr":1}', 0, '2026-04-19T10:00:00Z');
    qIns.run('q2', 'pr_env', '{"pr":2}', 0, '2026-04-19T10:00:01Z');
    qIns.run('q3', 'scaffold', '{"template":"next"}', 0, '2026-04-19T10:00:02Z');

    // Dispatcher pulls the oldest queued pr_env.
    const next = db
      .prepare(
        "SELECT id FROM pool_queue WHERE status = 'queued' AND class = 'pr_env' ORDER BY enqueued_at ASC LIMIT 1",
      )
      .get() as { id: string };
    expect(next.id).toBe('q1');

    // Bind it to a slot.
    db.prepare(
      'INSERT INTO pool_slots (slot_id, class, status, container_id, started_at, last_activity_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('pr-1', 'pr_env', 'busy', 'cont-abc', '2026-04-19T10:00:05Z', '2026-04-19T10:00:05Z');

    // Remove from queue (what the dispatcher does on successful spawn).
    db.prepare('DELETE FROM pool_queue WHERE id = ?').run('q1');

    const queued = db.prepare('SELECT COUNT(*) as n FROM pool_queue').get() as { n: number };
    const slots = db.prepare('SELECT COUNT(*) as n FROM pool_slots').get() as { n: number };
    expect(queued.n).toBe(2);
    expect(slots.n).toBe(1);

    // Metrics snapshot is appendable.
    db.prepare(
      'INSERT INTO pool_metrics (pool_util, queue_depth, evictions, reaps) VALUES (?, ?, ?, ?)',
    ).run(0.125, queued.n, 0, 0);
    const metrics = db.prepare('SELECT COUNT(*) as n FROM pool_metrics').get() as { n: number };
    expect(metrics.n).toBe(1);
  });
});
