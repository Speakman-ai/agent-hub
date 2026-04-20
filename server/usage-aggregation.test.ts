// Unit tests for usage-aggregation.ts — specifically the dedupe-per-parent
// behavior added to fix the cumulative `total_cost_usd` double-count bug.
// (See module header in usage-aggregation.ts for background.)

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  computeUsageTotals,
  computeUsageByAgent,
  computeUsageByDay,
  computeRecentSessions,
} from './usage-aggregation.js';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  // Minimal schema for the joins the aggregation relies on. Mirrors the
  // shape in `server/db.ts` — kept deliberately small so the tests stay
  // focused on aggregation semantics, not schema drift.
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      name TEXT
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_kind TEXT NOT NULL,
      parent_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function seedSession(db: Database.Database, sessionId: string, agentId: string): void {
  db.prepare('INSERT INTO sessions (id, agent_id, name) VALUES (?, ?, ?)').run(
    sessionId,
    agentId,
    `Session ${sessionId}`,
  );
}

function seedMessage(db: Database.Database, messageId: string, sessionId: string): void {
  db.prepare('INSERT INTO messages (id, session_id) VALUES (?, ?)').run(messageId, sessionId);
}

interface ResultEventInput {
  parentId: string;
  seq: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
  timestamp?: string;
  parentKind?: string;
}

function seedResultEvent(db: Database.Database, ev: ResultEventInput): void {
  db.prepare(
    `INSERT INTO session_events (parent_kind, parent_id, seq, event_type, payload, timestamp)
     VALUES (?, ?, ?, 'result', ?, COALESCE(?, datetime('now')))`,
  ).run(
    ev.parentKind ?? 'message',
    ev.parentId,
    ev.seq,
    JSON.stringify({
      costUsd: ev.costUsd,
      durationMs: ev.durationMs,
      numTurns: ev.numTurns,
    }),
    ev.timestamp ?? null,
  );
}

describe('usage-aggregation: dedupe cumulative cost per parent_id', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    seedSession(db, 'sess-a', 'agent-lead');
    seedMessage(db, 'msg-real-big', 'sess-a');
    seedMessage(db, 'msg-solo', 'sess-a');
  });

  it('reproduces the smoking-gun parent: 4 result events with cumulative cost are counted once', () => {
    // This mirrors the exact pattern from parent df840a36… (Apr 19 00:18):
    //   seq 485 → 106 turns, $27.97 (real 32-minute run)
    //   seq 492 →   1 turn,   $29.12 (ghost cumulative echo)
    //   seq 498 →   1 turn,   $29.26 (ghost)
    //   seq 504 →   1 turn,   $29.40 (ghost)
    // Naive SUM: $115.75. Correct (MAX-per-parent): $29.40.
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 485,
      costUsd: 27.97,
      durationMs: 1_922_019,
      numTurns: 106,
    });
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 492,
      costUsd: 29.12,
      durationMs: 2861,
      numTurns: 1,
    });
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 498,
      costUsd: 29.26,
      durationMs: 2219,
      numTurns: 1,
    });
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 504,
      costUsd: 29.4,
      durationMs: 2326,
      numTurns: 1,
    });

    const totals = computeUsageTotals(db);

    // Cost: dedupe to the cumulative MAX — NOT the naive sum of $115.75.
    expect(totals.total_cost).toBeCloseTo(29.4, 5);
    // count/duration/turns are per-emission and remain summed.
    expect(totals.count).toBe(4);
    expect(totals.total_turns).toBe(106 + 1 + 1 + 1);
    expect(totals.total_duration_ms).toBe(1_922_019 + 2861 + 2219 + 2326);
  });

  it('leaves single-result-per-parent invocations untouched', () => {
    seedResultEvent(db, {
      parentId: 'msg-solo',
      seq: 1,
      costUsd: 1.23,
      durationMs: 5000,
      numTurns: 3,
    });

    const totals = computeUsageTotals(db);
    expect(totals.total_cost).toBeCloseTo(1.23, 5);
    expect(totals.count).toBe(1);
    expect(totals.total_turns).toBe(3);
  });

  it('mixes deduped + solo parents correctly across the full corpus', () => {
    // One cumulative multi-emission parent ($10.00 final) plus two solo
    // parents ($2.50 + $0.75). Naive sum would be $10.00+$5.00+$7.50 + ...
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 1,
      costUsd: 5.0,
      durationMs: 1000,
      numTurns: 10,
    });
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 2,
      costUsd: 7.5,
      durationMs: 500,
      numTurns: 1,
    });
    seedResultEvent(db, {
      parentId: 'msg-real-big',
      seq: 3,
      costUsd: 10.0,
      durationMs: 500,
      numTurns: 1,
    });
    seedResultEvent(db, {
      parentId: 'msg-solo',
      seq: 1,
      costUsd: 2.5,
      durationMs: 2000,
      numTurns: 4,
    });
    seedMessage(db, 'msg-third', 'sess-a');
    seedResultEvent(db, {
      parentId: 'msg-third',
      seq: 1,
      costUsd: 0.75,
      durationMs: 300,
      numTurns: 2,
    });

    const totals = computeUsageTotals(db);
    expect(totals.total_cost).toBeCloseTo(10.0 + 2.5 + 0.75, 5); // $13.25, not $25.75
    expect(totals.count).toBe(5);
  });
});

describe('usage-aggregation: grouped queries dedupe too', () => {
  it('byAgent attributes deduped cost to the right agent', () => {
    const db = makeDb();
    seedSession(db, 'sess-a', 'agent-lead');
    seedSession(db, 'sess-b', 'agent-worker');
    seedMessage(db, 'msg-a1', 'sess-a');
    seedMessage(db, 'msg-b1', 'sess-b');

    // agent-lead: cumulative 3-emission parent ($5 max)
    seedResultEvent(db, { parentId: 'msg-a1', seq: 1, costUsd: 2, durationMs: 100, numTurns: 5 });
    seedResultEvent(db, { parentId: 'msg-a1', seq: 2, costUsd: 4, durationMs: 50, numTurns: 1 });
    seedResultEvent(db, { parentId: 'msg-a1', seq: 3, costUsd: 5, durationMs: 50, numTurns: 1 });
    // agent-worker: single result ($1)
    seedResultEvent(db, { parentId: 'msg-b1', seq: 1, costUsd: 1, durationMs: 200, numTurns: 2 });

    const byAgent = computeUsageByAgent(db);
    const lead = byAgent.find((r) => r.agent_id === 'agent-lead')!;
    const worker = byAgent.find((r) => r.agent_id === 'agent-worker')!;

    expect(lead.total_cost).toBeCloseTo(5, 5); // NOT 2+4+5 = $11
    expect(lead.count).toBe(3);
    expect(lead.total_turns).toBe(7);
    expect(worker.total_cost).toBeCloseTo(1, 5);
  });

  it("byDay attributes deduped cost to the max-cost row's day", () => {
    const db = makeDb();
    seedSession(db, 'sess-a', 'agent-lead');
    seedMessage(db, 'msg-crossday', 'sess-a');

    // Same parent spans two days. Ghost cumulative emission sits on day 2;
    // MAX-cost row is on day 2, so cost attributes to day 2.
    seedResultEvent(db, {
      parentId: 'msg-crossday',
      seq: 1,
      costUsd: 10,
      durationMs: 1000,
      numTurns: 50,
      timestamp: '2026-04-18 23:59:00',
    });
    seedResultEvent(db, {
      parentId: 'msg-crossday',
      seq: 2,
      costUsd: 11,
      durationMs: 500,
      numTurns: 1,
      timestamp: '2026-04-19 00:00:30',
    });

    const byDay = computeUsageByDay(db);
    const apr19 = byDay.find((r) => r.day === '2026-04-19')!;
    const apr18 = byDay.find((r) => r.day === '2026-04-18');

    // Cost goes to the MAX row's day (apr 19) — NOT split.
    expect(apr19.cost).toBeCloseTo(11, 5);
    // Apr 18 row still exists (for duration/turns/count) but contributes $0
    // of cost — its row is rn>1.
    expect(apr18?.cost ?? 0).toBeCloseTo(0, 5);
    // Duration is per-emission; apr 18 keeps its own.
    expect(apr18?.duration_ms).toBe(1000);
    expect(apr19.duration_ms).toBe(500);
  });

  it('recentSessions returns deduped cost per session', () => {
    const db = makeDb();
    seedSession(db, 'sess-hot', 'agent-lead');
    seedMessage(db, 'msg-hot', 'sess-hot');

    seedResultEvent(db, { parentId: 'msg-hot', seq: 1, costUsd: 3, durationMs: 100, numTurns: 5 });
    seedResultEvent(db, { parentId: 'msg-hot', seq: 2, costUsd: 4, durationMs: 50, numTurns: 1 });

    const recent = computeRecentSessions(db);
    const row = recent.find((r) => r.id === 'sess-hot')!;
    expect(row.cost).toBeCloseTo(4, 5); // dedupe — NOT 3+4
    expect(row.message_count).toBe(2); // raw row count
    expect(row.duration_ms).toBe(150); // per-emission sum
  });
});
