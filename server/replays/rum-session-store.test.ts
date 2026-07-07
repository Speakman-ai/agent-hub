import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  extractSegmentRollupCounts,
  rollupSegmentIntoSession,
  getRumSession,
  listRumSessionsByProject,
  type SegmentRollupInput,
} from './rum-session-store.js';
import type { RumSessionRow, Stmts } from '../types.js';

function makeStmts(): Stmts {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rum_sessions (
      session_id TEXT PRIMARY KEY,
      project_id TEXT,
      started_at INTEGER,
      ended_at INTEGER,
      time_spent INTEGER NOT NULL DEFAULT 0,
      view_count INTEGER NOT NULL DEFAULT 0,
      action_count INTEGER NOT NULL DEFAULT 0,
      error_count INTEGER NOT NULL DEFAULT 0,
      frustration_count INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_rum_sessions_project
      ON rum_sessions(project_id, started_at DESC);
  `);
  return {
    insertRumSession: db.prepare(
      `INSERT INTO rum_sessions
         (session_id, project_id, started_at, ended_at, time_spent,
          view_count, action_count, error_count, frustration_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    getRumSession: db.prepare('SELECT * FROM rum_sessions WHERE session_id = ?'),
    updateRumSessionRollup: db.prepare(
      `UPDATE rum_sessions
          SET project_id = ?, started_at = ?, ended_at = ?, time_spent = ?,
              view_count = ?, action_count = ?, error_count = ?, frustration_count = ?,
              updated_at = datetime('now')
        WHERE session_id = ?`,
    ),
    listRumSessionsByProject: db.prepare(
      `SELECT * FROM rum_sessions
        WHERE project_id = ?
        ORDER BY started_at DESC, session_id DESC
        LIMIT ?`,
    ),
    deleteRumSession: db.prepare('DELETE FROM rum_sessions WHERE session_id = ?'),
  } as unknown as Stmts;
}

/** Build a rollup input with sensible defaults; override per test. */
function input(over: Partial<SegmentRollupInput> = {}): SegmentRollupInput {
  return {
    sessionId: 'sess',
    projectId: 'proj',
    indexInView: 0,
    startTs: 1000,
    endTs: 2000,
    counts: { action: 0, error: 0, frustration: 0 },
    ...over,
  };
}

describe('extractSegmentRollupCounts', () => {
  it('reads camelCase count keys', () => {
    expect(
      extractSegmentRollupCounts({ actionCount: 3, errorCount: 1, frustrationCount: 2 }),
    ).toEqual({ action: 3, error: 1, frustration: 2 });
  });

  it('reads snake_case count keys', () => {
    expect(
      extractSegmentRollupCounts({ action_count: 4, error_count: 2, frustration_count: 5 }),
    ).toEqual({ action: 4, error: 2, frustration: 5 });
  });

  it('defaults missing / invalid counts to 0', () => {
    expect(extractSegmentRollupCounts(null)).toEqual({ action: 0, error: 0, frustration: 0 });
    expect(extractSegmentRollupCounts({})).toEqual({ action: 0, error: 0, frustration: 0 });
    expect(
      extractSegmentRollupCounts({ actionCount: -1, errorCount: NaN, frustrationCount: 'x' }),
    ).toEqual({ action: 0, error: 0, frustration: 0 });
  });

  it('coerces numeric strings and floors fractional counts', () => {
    expect(extractSegmentRollupCounts({ actionCount: '7', errorCount: 2.9 })).toEqual({
      action: 7,
      error: 2,
      frustration: 0,
    });
  });
});

describe('rollupSegmentIntoSession', () => {
  let stmts: Stmts;
  beforeEach(() => {
    stmts = makeStmts();
  });

  it('creates the session row from the first (index 0) segment', () => {
    const row = rollupSegmentIntoSession(
      stmts,
      input({ startTs: 1000, endTs: 1500, counts: { action: 2, error: 1, frustration: 0 } }),
    );
    expect(row.session_id).toBe('sess');
    expect(row.project_id).toBe('proj');
    expect(row.view_count).toBe(1);
    expect(row.action_count).toBe(2);
    expect(row.error_count).toBe(1);
    expect(row.frustration_count).toBe(0);
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(1500);
    expect(row.time_spent).toBe(500);
  });

  it('accumulates counts across segments within the same view (view_count stays 1)', () => {
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 0,
        startTs: 1000,
        endTs: 1500,
        counts: { action: 1, error: 0, frustration: 0 },
      }),
    );
    rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 1,
        startTs: 1500,
        endTs: 2000,
        counts: { action: 2, error: 1, frustration: 3 },
      }),
    );
    const row = rollupSegmentIntoSession(
      stmts,
      input({
        indexInView: 2,
        startTs: 2000,
        endTs: 2600,
        counts: { action: 0, error: 2, frustration: 1 },
      }),
    );
    expect(row.view_count).toBe(1); // one view, three segments
    expect(row.action_count).toBe(3);
    expect(row.error_count).toBe(3);
    expect(row.frustration_count).toBe(4);
    // time_spent spans first-segment start to last-segment end.
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(2600);
    expect(row.time_spent).toBe(1600);
  });

  it('increments view_count once per view (each index-0 segment)', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 1000, endTs: 1200 }));
    rollupSegmentIntoSession(stmts, input({ indexInView: 1, startTs: 1200, endTs: 1400 }));
    // Second view opens with its own index-0 segment.
    const row = rollupSegmentIntoSession(
      stmts,
      input({ indexInView: 0, startTs: 1400, endTs: 1800 }),
    );
    expect(row.view_count).toBe(2);
    expect(row.ended_at).toBe(1800);
    expect(row.time_spent).toBe(800);
  });

  it('derives time_spent from first/last event across many views', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 5000, endTs: 5200 }));
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 6000, endTs: 6400 }));
    const row = getRumSession(stmts, 'sess')!;
    expect(row.started_at).toBe(5000);
    expect(row.ended_at).toBe(6400);
    expect(row.time_spent).toBe(1400);
  });

  it('attributes project first-non-null-wins (anonymous first, then a token)', () => {
    rollupSegmentIntoSession(stmts, input({ projectId: null, indexInView: 0 }));
    let row = getRumSession(stmts, 'sess')!;
    expect(row.project_id).toBeNull();
    // A later attributed segment adopts the tenant.
    row = rollupSegmentIntoSession(stmts, input({ projectId: 'proj-x', indexInView: 1 }));
    expect(row.project_id).toBe('proj-x');
    // A still-later different token does NOT steal the session.
    row = rollupSegmentIntoSession(stmts, input({ projectId: 'proj-y', indexInView: 2 }));
    expect(row.project_id).toBe('proj-x');
  });

  it('ignores empty segments (start/end 0) when folding time bounds', () => {
    rollupSegmentIntoSession(stmts, input({ indexInView: 0, startTs: 1000, endTs: 1500 }));
    const row = rollupSegmentIntoSession(stmts, input({ indexInView: 1, startTs: 0, endTs: 0 }));
    expect(row.started_at).toBe(1000);
    expect(row.ended_at).toBe(1500);
    expect(row.time_spent).toBe(500);
  });

  it('rolls independent sessions into independent rows', () => {
    rollupSegmentIntoSession(stmts, input({ sessionId: 'a', projectId: 'proj', indexInView: 0 }));
    rollupSegmentIntoSession(stmts, input({ sessionId: 'b', projectId: 'proj', indexInView: 0 }));
    rollupSegmentIntoSession(stmts, input({ sessionId: 'b', projectId: 'proj', indexInView: 1 }));
    const list = listRumSessionsByProject(stmts, 'proj', 100);
    expect(list.map((r: RumSessionRow) => r.session_id).sort()).toEqual(['a', 'b']);
  });
});
