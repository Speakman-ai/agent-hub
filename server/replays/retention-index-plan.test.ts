import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'os';
import path from 'path';
import { mkdirSync, rmSync } from 'fs';
import Database from 'better-sqlite3';
import { initDb, getDb } from '../db.js';
import { getRumEventsDb } from './rum-events-db.js';

/**
 * Finding-1 regression: the per-project retention sweep queries must seek via a
 * (project_id, <age>) composite index, not scan/sort the whole global range per
 * tenant every sweep. Runs EXPLAIN QUERY PLAN against the REAL schema built by
 * initDb() (no replicated DDL), so it stays honest if an index is dropped/renamed.
 */
function planDetails(db: Database.Database, sql: string, params: unknown[]): string {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[];
  return rows.map((r) => r.detail).join(' | ');
}

describe('per-project retention sweep index coverage', () => {
  let dataDir: string;
  let db: Database.Database;
  // rum_segments / rum_sessions live in the dedicated rum.db (hot-write
  // isolation); their query plans must be checked against that handle.
  let rumDb: Database.Database;

  beforeAll(() => {
    dataDir = path.join(
      os.tmpdir(),
      `agent-hub-retention-idx-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(dataDir, { recursive: true });
    initDb(dataDir);
    db = getDb();
    rumDb = getRumEventsDb();
  });

  afterAll(() => {
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('session_replays per-project sweep seeks via a project_id composite index', () => {
    const detail = planDetails(
      db,
      `SELECT * FROM session_replays
         WHERE created_at < ?
           AND (retained_until IS NULL OR retained_until <= ?)
           AND support_ticket_id IS NULL
           AND card_id IS NULL
           AND project_id = ?
         ORDER BY created_at ASC
         LIMIT ?`,
      ['2026-01-01 00:00:00', '2026-01-01 00:00:00', 'proj', 10],
    );
    // Seeks the tenant's rows via the (project_id, created_at) composite — not a
    // full table scan.
    expect(detail).toContain('idx_session_replays_project');
    expect(detail).not.toMatch(/SCAN session_replays\b/);
  });

  it('rum_sessions per-project sweep seeks via idx_rum_sessions_project_updated', () => {
    const detail = planDetails(
      rumDb,
      `SELECT * FROM rum_sessions
         WHERE updated_at < ? AND project_id = ?
         ORDER BY updated_at ASC
         LIMIT ?`,
      ['2026-01-01 00:00:00', 'proj', 10],
    );
    expect(detail).toContain('idx_rum_sessions_project_updated');
    expect(detail).not.toMatch(/SCAN rum_sessions\b/);
  });

  it('rum_segments per-project orphan sweep seeks via idx_rum_segments_project_created', () => {
    const detail = planDetails(
      rumDb,
      `SELECT s.* FROM rum_segments s
         WHERE s.created_at < ?
           AND s.project_id = ?
           AND NOT EXISTS (SELECT 1 FROM rum_sessions rs WHERE rs.session_id = s.session_id)
         ORDER BY s.created_at ASC
         LIMIT ?`,
      ['2026-01-01 00:00:00', 'proj', 10],
    );
    expect(detail).toContain('idx_rum_segments_project_created');
    expect(detail).not.toMatch(/SCAN rum_segments\b/);
  });
});
