import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { initDb, getDb, getStmts } from './db.js';
import type { Stmts } from './types.js';

/**
 * Regression coverage for the DB hot-spot indexes (card #1413). The Phase-1
 * wall-time instrumentation flagged these read paths as full-table SCANs +
 * TEMP B-TREE sorts against the two unboundedly-growing, frequently-queried
 * tables (`sessions`, `finalize_runs`). Two of them — getRecentLiveSessions
 * and getActiveFinalizeRuns — run on EVERY WebSocket-connect handshake, so a
 * scan of a large table stalls the Node event loop on every reconnect.
 *
 * Every assertion runs EXPLAIN QUERY PLAN against the EXACT SQL of the shipped
 * prepared statement (read back via `stmt.source`), not a hand-copied string.
 * That closes the drift gap: if any of the four queries' ORDER BY / predicate /
 * status list changes in db.ts, the plan re-derives here and the test catches a
 * regression automatically instead of asserting against a stale copy.
 */
function planForStmt(db: Database.Database, source: string): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${source}`).all() as { detail: string }[];
  return rows.map((r) => r.detail).join(' | ');
}

describe('DB hot-spot index coverage', () => {
  let dataDir: string;
  let db: Database.Database;
  let stmts: Stmts;

  beforeAll(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-hotspot-idx-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    initDb(dataDir);
    db = getDb();
    stmts = getStmts();
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('getRecentLiveSessions seeks via idx_sessions_live with no sort (WS-connect hot path)', () => {
    const detail = planForStmt(db, stmts.getRecentLiveSessions.source);
    // Composite (deleted_at, updated_at DESC): seek the live rows and read them
    // already ordered — no full scan, no TEMP B-TREE sort of the whole set.
    expect(detail).toContain('idx_sessions_live');
    expect(detail).not.toMatch(/SCAN sessions\b/);
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('getStalePendingPrSessions seeks via the partial idx_sessions_stale_pr', () => {
    const detail = planForStmt(db, stmts.getStalePendingPrSessions.source);
    expect(detail).toContain('idx_sessions_stale_pr');
    expect(detail).not.toMatch(/SCAN sessions\b/);
  });

  it('getAllCronSessions drives the join off the partial idx_sessions_cron', () => {
    const detail = planForStmt(db, stmts.getAllCronSessions.source);
    // The partial index bounds the driving scan to just the cron-linked
    // sessions instead of the whole table.
    expect(detail).toContain('idx_sessions_cron');
    expect(detail).not.toMatch(/SCAN s\b(?! USING INDEX)/);
  });

  it('getActiveFinalizeRuns seeks via the partial idx_finalize_runs_active with no sort (WS-connect hot path)', () => {
    const detail = planForStmt(db, stmts.getActiveFinalizeRuns.source);
    // Partial index over just the active runs, pre-ordered by the full
    // (started_at DESC, id DESC) tiebreak: short ordered index scan, no full
    // scan of the (mostly-terminal) table and no TEMP B-TREE sort — including
    // the LAST TERM OF ORDER BY, which only the id column in the index covers.
    expect(detail).toContain('idx_finalize_runs_active');
    expect(detail).not.toMatch(/SCAN finalize_runs\b(?! USING INDEX)/);
    expect(detail).not.toContain('USE TEMP B-TREE');
  });

  it('the redundant single-column idx_sessions_deleted_at is dropped in favor of the composite', () => {
    const idx = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_sessions_deleted_at'`,
      )
      .get();
    expect(idx).toBeUndefined();
  });
});
