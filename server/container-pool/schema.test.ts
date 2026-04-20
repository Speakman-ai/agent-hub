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

/** Pre-#458 schema: no last_error column, status CHECK lacks 'failed'. */
const PRE_458_SCHEMA = `
  CREATE TABLE IF NOT EXISTS pool_slots (
    slot_id          TEXT PRIMARY KEY,
    class            TEXT NOT NULL CHECK(class IN ('pr_env','scaffold','overflow')),
    status           TEXT NOT NULL DEFAULT 'free'
                       CHECK(status IN ('free','reserved','busy','draining')),
    container_id     TEXT,
    started_at       TEXT,
    last_activity_at TEXT,
    UNIQUE(container_id)
  );
  CREATE TABLE IF NOT EXISTS pool_queue (
    id             TEXT PRIMARY KEY,
    class          TEXT NOT NULL CHECK(class IN ('pr_env','scaffold')),
    payload        TEXT NOT NULL,
    priority_tier  INTEGER NOT NULL DEFAULT 0,
    enqueued_at    TEXT NOT NULL DEFAULT (datetime('now')),
    status         TEXT NOT NULL DEFAULT 'queued'
                     CHECK(status IN ('queued','dispatching','failed'))
  );
  CREATE INDEX IF NOT EXISTS idx_pool_queue_status_enqueued_at
    ON pool_queue(status, enqueued_at);
  CREATE TABLE IF NOT EXISTS pool_metrics (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp   TEXT NOT NULL DEFAULT (datetime('now')),
    pool_util   REAL NOT NULL,
    queue_depth INTEGER NOT NULL,
    evictions   INTEGER NOT NULL DEFAULT 0,
    reaps       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_pool_metrics_timestamp
    ON pool_metrics(timestamp);
`;

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
      [
        'class',
        'container_id',
        'last_activity_at',
        'last_error',
        'last_http_hit_at',
        'pr_last_commit_at',
        'pr_number',
        'pr_state',
        'reviewer_activity_at',
        'slot_id',
        'started_at',
        'status',
      ].sort(),
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
    // last_error is nullable — only populated on the failed → reclaim path.
    expect(byName.last_error.notnull).toBe(0);
    // W4 eviction metadata: all nullable (populated lazily by the lifecycle
    // layer / webhooks, not required at bind time).
    expect(byName.pr_number.notnull).toBe(0);
    expect(byName.pr_state.notnull).toBe(0);
    expect(byName.pr_last_commit_at.notnull).toBe(0);
    expect(byName.last_http_hit_at.notnull).toBe(0);
    expect(byName.reviewer_activity_at.notnull).toBe(0);
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

describe('container pool schema — migration from pre-#458 shape', () => {
  it('migrates a pre-#458 DB: adds last_error column and extends status CHECK', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    // Seed with old schema (no last_error, CHECK lacks "failed").
    db.exec(PRE_458_SCHEMA);

    // Insert a row with the old shape to verify data survives.
    db.prepare(
      "INSERT INTO pool_slots (slot_id, class, status, container_id) VALUES ('pr-1', 'pr_env', 'busy', 'c-abc')",
    ).run();

    // The old CHECK rejects 'failed'.
    expect(() =>
      db
        .prepare(
          "INSERT INTO pool_slots (slot_id, class, status) VALUES ('pr-2', 'pr_env', 'failed')",
        )
        .run(),
    ).toThrow(/CHECK constraint failed/i);

    // --- Run the same migration logic as db.ts ---
    try {
      db.exec('ALTER TABLE pool_slots ADD COLUMN last_error TEXT');
    } catch (_e) {
      /* already exists */
    }

    const ddl =
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pool_slots'")
          .get() as { sql: string } | undefined
      )?.sql ?? '';
    if (ddl && !ddl.includes("'failed'")) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE pool_slots_new (
            slot_id          TEXT PRIMARY KEY,
            class            TEXT NOT NULL CHECK(class IN ('pr_env','scaffold','overflow')),
            status           TEXT NOT NULL DEFAULT 'free'
                               CHECK(status IN ('free','reserved','busy','draining','failed')),
            container_id     TEXT,
            started_at       TEXT,
            last_activity_at TEXT,
            last_error       TEXT,
            UNIQUE(container_id)
          );
          INSERT INTO pool_slots_new (slot_id, class, status, container_id, started_at, last_activity_at, last_error)
            SELECT slot_id, class, status, container_id, started_at, last_activity_at, last_error FROM pool_slots;
          DROP TABLE pool_slots;
          ALTER TABLE pool_slots_new RENAME TO pool_slots;
        `);
      })();
    }

    // Re-apply POOL_SCHEMA (as db.ts does) — should be a no-op.
    expect(() => db.exec(POOL_SCHEMA)).not.toThrow();

    // Verify the migrated row survived.
    const row = db.prepare('SELECT * FROM pool_slots WHERE slot_id = ?').get('pr-1') as Record<
      string,
      unknown
    >;
    expect(row.class).toBe('pr_env');
    expect(row.status).toBe('busy');
    expect(row.container_id).toBe('c-abc');

    // Verify last_error column exists and is nullable.
    const info = db.pragma('table_info(pool_slots)') as TableInfoRow[];
    const lastError = info.find((c) => c.name === 'last_error');
    expect(lastError).toBeDefined();
    expect(lastError!.notnull).toBe(0);

    // Verify 'failed' is now accepted by the CHECK constraint.
    expect(() =>
      db
        .prepare(
          "INSERT INTO pool_slots (slot_id, class, status) VALUES ('pr-2', 'pr_env', 'failed')",
        )
        .run(),
    ).not.toThrow();
  });

  it('is a no-op when the DB already has the new schema', () => {
    const db = freshDb();
    // Insert a row.
    db.prepare(
      "INSERT INTO pool_slots (slot_id, class, status) VALUES ('pr-1', 'pr_env', 'failed')",
    ).run();

    // Run migration again — should not throw or lose data.
    try {
      db.exec('ALTER TABLE pool_slots ADD COLUMN last_error TEXT');
    } catch (_e) {
      /* already exists */
    }

    const ddl =
      (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pool_slots'")
          .get() as { sql: string } | undefined
      )?.sql ?? '';
    // DDL already contains 'failed', so the rebuild should be skipped.
    expect(ddl).toContain("'failed'");

    const row = db.prepare('SELECT status FROM pool_slots WHERE slot_id = ?').get('pr-1') as {
      status: string;
    };
    expect(row.status).toBe('failed');
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
