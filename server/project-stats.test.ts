import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { buildStatBuckets, normalizeBucketCount, computeProjectStats } from './project-stats.js';

describe('buildStatBuckets', () => {
  it('builds daily buckets ending at now', () => {
    const b = buildStatBuckets('day', 3, new Date('2026-07-16T12:00:00Z'));
    expect(b.map((x) => x.start)).toEqual(['2026-07-14', '2026-07-15', '2026-07-16']);
  });

  it('builds weekly buckets anchored to Monday', () => {
    // 2026-07-16 is a Thursday → its Monday is 2026-07-13.
    const b = buildStatBuckets('week', 2, new Date('2026-07-16T12:00:00Z'));
    expect(b.map((x) => x.start)).toEqual(['2026-07-06', '2026-07-13']);
  });

  it('builds monthly buckets with YYYY-MM labels', () => {
    const b = buildStatBuckets('month', 3, new Date('2026-07-16T12:00:00Z'));
    expect(b.map((x) => x.start)).toEqual(['2026-05-01', '2026-06-01', '2026-07-01']);
    expect(b.map((x) => x.label)).toEqual(['2026-05', '2026-06', '2026-07']);
  });
});

describe('normalizeBucketCount', () => {
  it('falls back to the default and clamps to the max', () => {
    expect(normalizeBucketCount('day', undefined)).toBe(30);
    expect(normalizeBucketCount('day', 0)).toBe(1);
    expect(normalizeBucketCount('day', 999)).toBe(90);
    expect(normalizeBucketCount('week', 4)).toBe(4);
  });
});

describe('computeProjectStats', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE kanban_boards (id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL,
        created_at TEXT, completed_at TEXT
      );
      CREATE TABLE kanban_epics (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE support_tickets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, resolved_at TEXT
      );
      CREATE TABLE pull_requests (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT, merged_at INTEGER
      );
      CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL);
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL, model TEXT, created_at TEXT
      );
      INSERT INTO kanban_boards (id, project_id) VALUES ('b1', 'p1'), ('b2', 'p2');
    `);

    // tickets_made: 2 in-window, 1 outside
    db.exec(`
      INSERT INTO kanban_cards (id, board_id, created_at, completed_at) VALUES
        ('c1', 'b1', '2026-07-16 09:00:00', '2026-07-16 10:00:00'),
        ('c2', 'b1', '2026-07-15 09:00:00', NULL),
        ('c3', 'b1', '2026-07-01 09:00:00', NULL);
    `);
    // epics_completed: 1 in-window
    db.exec(
      `INSERT INTO kanban_epics (id, board_id, completed_at) VALUES ('e1', 'b1', '2026-07-14 00:00:00');`,
    );
    // support resolved: p1 in-window (counts), p2 excluded
    db.exec(`
      INSERT INTO support_tickets (id, project_id, resolved_at) VALUES
        ('t1', 'p1', '2026-07-16 08:00:00'),
        ('t2', 'p2', '2026-07-16 08:00:00');
    `);
    const merged = Date.parse('2026-07-16T09:00:00Z');
    const old = Date.parse('2026-07-01T09:00:00Z');
    db.prepare(
      'INSERT INTO pull_requests (id, project_id, status, merged_at) VALUES (?,?,?,?)',
    ).run('pr1', 'p1', 'merged', merged);
    db.prepare(
      'INSERT INTO pull_requests (id, project_id, status, merged_at) VALUES (?,?,?,?)',
    ).run('pr2', 'p1', 'open', null);
    db.prepare(
      'INSERT INTO pull_requests (id, project_id, status, merged_at) VALUES (?,?,?,?)',
    ).run('pr3', 'p2', 'merged', merged);
    db.prepare(
      'INSERT INTO pull_requests (id, project_id, status, merged_at) VALUES (?,?,?,?)',
    ).run('pr4', 'p1', 'merged', old);
    // model usage — a1 in project, aX not
    db.exec(`
      INSERT INTO sessions (id, agent_id) VALUES ('s1', 'a1'), ('s2', 'aX');
      INSERT INTO messages (id, session_id, model, created_at) VALUES
        ('m1', 's1', 'opus', '2026-07-16 09:00:00'),
        ('m2', 's1', 'opus', '2026-07-15 09:00:00'),
        ('m3', 's1', 'sonnet', '2026-07-14 09:00:00'),
        ('m4', 's2', 'opus', '2026-07-16 09:00:00');
    `);
  });

  afterEach(() => db.close());

  it('aggregates totals, series, and top model scoped to the project', () => {
    const stats = computeProjectStats(db, {
      projectId: 'p1',
      agentIds: ['a1'],
      granularity: 'day',
      count: 7,
      now: new Date('2026-07-16T12:00:00Z'),
    });

    expect(stats.buckets).toHaveLength(7);
    expect(stats.buckets[0].start).toBe('2026-07-10');
    expect(stats.buckets[6].start).toBe('2026-07-16');

    expect(stats.totals).toEqual({
      prs_merged: 1, // pr4 (old) + pr3 (other project) + pr2 (open) excluded
      support_tickets_resolved: 1, // t2 (p2) excluded
      tickets_made: 2, // c3 (outside window) excluded
      tickets_completed: 1,
      epics_completed: 1,
    });

    // Last bucket (2026-07-16) carries the day-of events.
    expect(stats.series.prs_merged[6]).toBe(1);
    expect(stats.series.tickets_made[6]).toBe(1);
    expect(stats.series.tickets_completed[6]).toBe(1);
    expect(stats.series.support_tickets_resolved[6]).toBe(1);
    // Epic completed on the 2026-07-14 bucket (index 4).
    expect(stats.series.epics_completed[4]).toBe(1);

    expect(stats.top_model).toBe('opus');
    expect(stats.model_usage).toEqual([
      { model: 'opus', count: 2 },
      { model: 'sonnet', count: 1 },
    ]);
  });

  it('returns empty model usage when the project has no agents', () => {
    const stats = computeProjectStats(db, {
      projectId: 'p1',
      agentIds: [],
      granularity: 'day',
      count: 7,
      now: new Date('2026-07-16T12:00:00Z'),
    });
    expect(stats.model_usage).toEqual([]);
    expect(stats.top_model).toBeNull();
  });
});
