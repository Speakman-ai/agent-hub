/**
 * rum-events-db.test.ts — the dedicated RUM ingest event DB (`rum.db`).
 *
 * Regression guard for spec hot-write-isolation: the segment-ingest flood
 * tables (`rum_segments` + `rum_sessions`) must live in their own SQLite file
 * (own connection + WAL) beside each org's `agent-hub.db`. Writes must NOT land
 * in the primary connection, reads must resolve from the new file, and a legacy
 * install's rows must migrate out of `agent-hub.db` on startup (column-skew
 * safe), leaving the primary DB lean.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initDb, getDb, getStmts } from '../db.js';
import { getRumEventsDb, RUM_EVENTS_DB_FILENAME, RUM_EVENTS_SCHEMA } from './rum-events-db.js';

function primaryHasTable(name: string): boolean {
  return (
    getDb().prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name) !==
    undefined
  );
}

function rumHasTable(name: string): boolean {
  return (
    getRumEventsDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name) !== undefined
  );
}

describe('rum-events-db — dedicated ingest file', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'rum-events-db-'));
    initDb(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates rum.db beside agent-hub.db as a distinct connection', () => {
    expect(existsSync(path.join(dir, RUM_EVENTS_DB_FILENAME))).toBe(true);
    // Two different handles → a checkpoint on one cannot stall the other.
    expect(getRumEventsDb()).not.toBe(getDb());
  });

  it('rum_segments / rum_sessions live only in rum.db, never in the primary DB', () => {
    expect(primaryHasTable('rum_segments')).toBe(false);
    expect(primaryHasTable('rum_sessions')).toBe(false);
    expect(rumHasTable('rum_segments')).toBe(true);
    expect(rumHasTable('rum_sessions')).toBe(true);
    // A table that intentionally stayed in the primary DB is still there.
    expect(primaryHasTable('session_replays')).toBe(true);
    expect(primaryHasTable('project_rum_clients')).toBe(true);
  });

  it('ingest writes land in rum.db and read back from it, not the primary DB', () => {
    getStmts().insertRumSegment.run(
      'seg-1',
      'sess-1',
      'view-1',
      'proj-1',
      0,
      1,
      100,
      200,
      3,
      42,
      'local',
      'rum/seg-1',
      null,
      null,
    );
    getStmts().insertRumSession.run(
      'sess-1',
      'proj-1',
      100,
      200,
      100,
      1,
      2,
      0,
      0,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    );

    // Reads resolve from the dedicated file.
    const seg = getRumEventsDb()
      .prepare('SELECT project_id FROM rum_segments WHERE id = ?')
      .get('seg-1') as { project_id: string } | undefined;
    expect(seg?.project_id).toBe('proj-1');
    expect(getStmts().getRumSegment.get('seg-1')).toBeDefined();
    expect(getStmts().getRumSession.get('sess-1')).toBeDefined();

    // The writes never touched the primary connection (tables absent there).
    expect(primaryHasTable('rum_segments')).toBe(false);
    expect(primaryHasTable('rum_sessions')).toBe(false);
  });

  it('migrates legacy in-primary rows into rum.db and drops the legacy tables (column-skew safe)', () => {
    // A pristine second data dir, seeded to look like a pre-split install: the
    // ingest tables still live inside agent-hub.db. The rum_sessions seed omits
    // the later enrichment columns to prove the intersection-copy migration.
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'rum-events-legacy-'));
    try {
      const primaryPath = path.join(legacyDir, 'agent-hub.db');
      const seed = new Database(primaryPath);
      seed.pragma('journal_mode = WAL');
      seed.exec(`
        CREATE TABLE rum_segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, view_id TEXT NOT NULL,
          project_id TEXT, index_in_view INTEGER NOT NULL,
          has_full_snapshot INTEGER NOT NULL DEFAULT 0,
          start_ts INTEGER NOT NULL DEFAULT 0, end_ts INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0,
          storage_kind TEXT NOT NULL, storage_key TEXT NOT NULL,
          storage_bucket TEXT, storage_region TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        -- Legacy rum_sessions WITHOUT device_type/browser/os/geo_country/usr_*.
        CREATE TABLE rum_sessions (
          session_id TEXT PRIMARY KEY, project_id TEXT, started_at INTEGER,
          ended_at INTEGER, time_spent INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0, action_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0, frustration_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      seed
        .prepare(
          `INSERT INTO rum_segments
             (id, session_id, view_id, project_id, index_in_view, storage_kind, storage_key)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run('legacy-seg', 'legacy-sess', 'v0', 'legacy-proj', 0, 'local', 'rum/legacy-seg');
      seed
        .prepare(
          `INSERT INTO rum_sessions (session_id, project_id, started_at, view_count)
           VALUES (?,?,?,?)`,
        )
        .run('legacy-sess', 'legacy-proj', 500, 4);
      seed.close();

      // Boot against the seeded dir: initDb opens rum.db then migrates rows out.
      initDb(legacyDir);

      // Rows moved to rum.db, columns absent in the source default in destination.
      const seg = getRumEventsDb()
        .prepare('SELECT project_id FROM rum_segments WHERE id = ?')
        .get('legacy-seg') as { project_id: string } | undefined;
      expect(seg?.project_id).toBe('legacy-proj');
      const sess = getRumEventsDb()
        .prepare('SELECT view_count, device_type FROM rum_sessions WHERE session_id = ?')
        .get('legacy-sess') as { view_count: number; device_type: string | null } | undefined;
      expect(sess?.view_count).toBe(4);
      expect(sess?.device_type).toBeNull();

      // Legacy tables dropped from the primary DB (clean cutover — stays lean).
      expect(primaryHasTable('rum_segments')).toBe(false);
      expect(primaryHasTable('rum_sessions')).toBe(false);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('preserves the legacy table when a pre-existing rum.db row diverges from the source', () => {
    // Round-2 root-cause regression. `INSERT OR IGNORE` never overwrites an
    // existing destination row, so a divergent destination row — a partial
    // migration then a live rollup update, a rollback, or a restored primary DB
    // paired with an existing rum.db — must NOT be treated as a completed
    // migration just because the primary key matches. Value-equality
    // verification blocks the drop; the legacy source is preserved and neither
    // side's values are discarded or clobbered. Here the ONLY difference is
    // view_count (1 in the source, 99 already in rum.db); every other shared
    // column is identical, isolating "same key, different payload".
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'rum-events-diverge-'));
    try {
      // Pre-seed the DESTINATION rum.db with the divergent rollup (view_count 99).
      const rumSeed = new Database(path.join(legacyDir, RUM_EVENTS_DB_FILENAME));
      rumSeed.pragma('journal_mode = WAL');
      rumSeed.exec(RUM_EVENTS_SCHEMA);
      rumSeed
        .prepare(
          `INSERT INTO rum_sessions
             (session_id, project_id, started_at, ended_at, time_spent, view_count,
              action_count, error_count, frustration_count, first_seen_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'sess-x',
          'proj',
          500,
          600,
          100,
          99,
          0,
          0,
          0,
          '2026-01-01 00:00:00',
          '2026-01-01 00:00:00',
        );
      rumSeed.close();

      // Legacy PRIMARY rum_sessions holds the SAME key with view_count 1 and all
      // other shared columns identical to the destination row above.
      const primarySeed = new Database(path.join(legacyDir, 'agent-hub.db'));
      primarySeed.pragma('journal_mode = WAL');
      primarySeed.exec(`
        CREATE TABLE rum_sessions (
          session_id TEXT PRIMARY KEY, project_id TEXT, started_at INTEGER,
          ended_at INTEGER, time_spent INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0, action_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0, frustration_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      primarySeed
        .prepare(
          `INSERT INTO rum_sessions
             (session_id, project_id, started_at, ended_at, time_spent, view_count,
              action_count, error_count, frustration_count, first_seen_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          'sess-x',
          'proj',
          500,
          600,
          100,
          1,
          0,
          0,
          0,
          '2026-01-01 00:00:00',
          '2026-01-01 00:00:00',
        );
      primarySeed.close();

      initDb(legacyDir);

      // Divergent payload → drop BLOCKED → legacy source preserved.
      expect(primaryHasTable('rum_sessions')).toBe(true);
      // Destination row was NOT clobbered (copy is non-destructive).
      expect(
        (
          getRumEventsDb()
            .prepare('SELECT view_count FROM rum_sessions WHERE session_id = ?')
            .get('sess-x') as { view_count: number }
        ).view_count,
      ).toBe(99);
      // Source value is intact — nothing discarded.
      expect(
        (
          getDb()
            .prepare('SELECT view_count FROM rum_sessions WHERE session_id = ?')
            .get('sess-x') as { view_count: number }
        ).view_count,
      ).toBe(1);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });

  it('re-init is idempotent and a no-op migration on a fresh install', () => {
    expect(() => initDb(dir)).not.toThrow();
    expect(primaryHasTable('rum_segments')).toBe(false);
    expect(rumHasTable('rum_segments')).toBe(true);
  });

  it('preserves the legacy table (no drop) when the copy is silently incomplete', () => {
    // Reviewer regression: the migration must NOT drop a source table whose rows
    // did not all reach rum.db — these tables are durable dashboard metadata, so
    // an unconditional drop-after-failed-copy is permanent data loss. We force a
    // silent partial copy: the legacy rum_segments makes storage_kind NULLABLE
    // and stores a row with a NULL storage_kind. The destination's storage_kind
    // is NOT NULL, so `INSERT OR IGNORE` skips that row without erroring — the
    // exact "startup succeeds but data is gone" scenario. rum_sessions is seeded
    // fully valid to prove per-table independence (it still migrates + drops).
    const legacyDir = mkdtempSync(path.join(os.tmpdir(), 'rum-events-partial-'));
    try {
      const primaryPath = path.join(legacyDir, 'agent-hub.db');
      const seed = new Database(primaryPath);
      seed.pragma('journal_mode = WAL');
      seed.exec(`
        -- storage_kind intentionally NULLABLE here (dest requires NOT NULL).
        CREATE TABLE rum_segments (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL, view_id TEXT NOT NULL,
          project_id TEXT, index_in_view INTEGER NOT NULL,
          has_full_snapshot INTEGER NOT NULL DEFAULT 0,
          start_ts INTEGER NOT NULL DEFAULT 0, end_ts INTEGER NOT NULL DEFAULT 0,
          event_count INTEGER NOT NULL DEFAULT 0, byte_size INTEGER NOT NULL DEFAULT 0,
          storage_kind TEXT, storage_key TEXT NOT NULL,
          storage_bucket TEXT, storage_region TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE rum_sessions (
          session_id TEXT PRIMARY KEY, project_id TEXT, started_at INTEGER,
          ended_at INTEGER, time_spent INTEGER NOT NULL DEFAULT 0,
          view_count INTEGER NOT NULL DEFAULT 0, action_count INTEGER NOT NULL DEFAULT 0,
          error_count INTEGER NOT NULL DEFAULT 0, frustration_count INTEGER NOT NULL DEFAULT 0,
          first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      const insSeg = seed.prepare(
        `INSERT INTO rum_segments
           (id, session_id, view_id, project_id, index_in_view, storage_kind, storage_key)
         VALUES (?,?,?,?,?,?,?)`,
      );
      insSeg.run('seg-ok', 'sess-a', 'v0', 'proj', 0, 'local', 'rum/seg-ok');
      // This row cannot satisfy the destination's NOT NULL storage_kind.
      insSeg.run('seg-bad', 'sess-b', 'v0', 'proj', 0, null, 'rum/seg-bad');
      seed
        .prepare(
          `INSERT INTO rum_sessions (session_id, project_id, started_at, view_count)
           VALUES (?,?,?,?)`,
        )
        .run('sess-a', 'proj', 500, 1);
      seed.close();

      initDb(legacyDir);

      // rum_segments copy was incomplete (seg-bad skipped) → source PRESERVED,
      // never dropped. No permanent loss: the operator/next boot can retry.
      expect(primaryHasTable('rum_segments')).toBe(true);
      // The row that DID copy is idempotently in rum.db (retry-safe).
      expect(
        getRumEventsDb().prepare('SELECT 1 FROM rum_segments WHERE id = ?').get('seg-ok'),
      ).toBeDefined();
      // The fully-valid rum_sessions table migrated and was dropped independently.
      expect(primaryHasTable('rum_sessions')).toBe(false);
      expect(
        getRumEventsDb().prepare('SELECT 1 FROM rum_sessions WHERE session_id = ?').get('sess-a'),
      ).toBeDefined();
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
