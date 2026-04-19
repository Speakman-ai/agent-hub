/**
 * PoolAllocator tests (W1).
 *
 * Exercises the four contract areas called out in the W1 brief:
 *   1. FIFO queue ordering (independent per class)
 *   2. Preemption rules (scaffold never evicts pr_env; pr_env wins overflow)
 *   3. Bounded-wait timeout (scaffold waits ≤120 s before taking overflow)
 *   4. Overflow slot contention
 *
 * All tests run against an in-memory SQLite DB seeded with POOL_SCHEMA
 * and drive time via an injected fake Clock. No real timers are used —
 * `tick()` is called manually between clock advances which is both faster
 * and more deterministic than Vitest's fake timers for this module.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import { DEFAULT_CONFIG, PoolAllocator, startDispatcher, type Clock } from './allocator.js';

// ─── helpers ──────────────────────────────────────────────────────────────

/** Deterministic clock — ms and ISO advance together via `set()`. */
function makeClock(startMs = Date.parse('2026-04-19T10:00:00Z')): Clock & {
  set(ms: number): void;
  advance(ms: number): void;
} {
  let cur = startMs;
  return {
    nowMs: () => cur,
    nowIso: () => new Date(cur).toISOString().slice(0, 19).replace('T', ' '),
    set(ms) {
      cur = ms;
    },
    advance(ms) {
      cur += ms;
    },
  };
}

function freshAllocator(config: Partial<typeof DEFAULT_CONFIG> = {}): {
  allocator: PoolAllocator;
  db: Database.Database;
  clock: ReturnType<typeof makeClock>;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  const clock = makeClock();
  const allocator = new PoolAllocator(db, { config, clock });
  allocator.init();
  return { allocator, db, clock };
}

function slotStatus(db: Database.Database, slotId: string): string {
  const row = db.prepare('SELECT status FROM pool_slots WHERE slot_id = ?').get(slotId) as
    | { status: string }
    | undefined;
  return row?.status ?? 'missing';
}

function boundContainer(db: Database.Database, slotId: string): string | null {
  const row = db.prepare('SELECT container_id FROM pool_slots WHERE slot_id = ?').get(slotId) as
    | { container_id: string | null }
    | undefined;
  return row?.container_id ?? null;
}

// ─── suite ────────────────────────────────────────────────────────────────

describe('PoolAllocator.init — seeds the configured fleet', () => {
  it('creates pr, scaffold, and overflow slots per config', () => {
    const { db } = freshAllocator({ prEnvSlots: 2, scaffoldSlots: 2, overflowSlots: 1 });
    const counts = db
      .prepare('SELECT class, COUNT(*) AS n FROM pool_slots GROUP BY class ORDER BY class')
      .all() as Array<{ class: string; n: number }>;
    expect(counts).toEqual([
      { class: 'overflow', n: 1 },
      { class: 'pr_env', n: 2 },
      { class: 'scaffold', n: 2 },
    ]);
  });

  it('is idempotent — re-init preserves existing slot bindings', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 1, overflowSlots: 1 });
    db.prepare(
      "UPDATE pool_slots SET status='busy', container_id='c-abc' WHERE slot_id='pr-1'",
    ).run();

    allocator.init();
    const row = db
      .prepare('SELECT status, container_id FROM pool_slots WHERE slot_id = ?')
      .get('pr-1') as { status: string; container_id: string };
    expect(row.status).toBe('busy');
    expect(row.container_id).toBe('c-abc');
  });
});

describe('queue ordering — FIFO within each class, independent across classes', () => {
  it('dispatches PR env requests in enqueue order', () => {
    const { allocator } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 1, overflowSlots: 0 });
    const ids = [
      allocator.enqueue('pr_env', { pr: 1 }),
      allocator.enqueue('pr_env', { pr: 2 }),
      allocator.enqueue('pr_env', { pr: 3 }),
    ];
    // Only one PR slot, so we must free it between ticks to see order.
    let assigned: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = allocator.tick();
      assigned = assigned.concat(result.assigned.map((d) => d.queueId));
      allocator.release('pr-1');
    }
    expect(assigned).toEqual(ids);
  });

  it('dispatches scaffold requests in enqueue order', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 1,
      overflowSlots: 0,
    });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      // Advance clock so enqueued_at timestamps are distinct at 1-sec res.
      clock.advance(1500);
      ids.push(allocator.enqueue('scaffold', { template: `t${i}` }));
    }
    const dispatched: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = allocator.tick();
      dispatched.push(...result.assigned.map((d) => d.queueId));
      allocator.release('scaffold-1');
    }
    expect(dispatched).toEqual(ids);
  });

  it('queues are independent — PR env backlog does not delay scaffold', () => {
    const { allocator } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 1, overflowSlots: 0 });
    // PR env fills its only slot and has 3 more queued.
    const pr1 = allocator.enqueue('pr_env', { pr: 1 });
    allocator.enqueue('pr_env', { pr: 2 });
    allocator.enqueue('pr_env', { pr: 3 });
    allocator.enqueue('pr_env', { pr: 4 });
    const scaf = allocator.enqueue('scaffold', { template: 'next' });

    const result = allocator.tick();
    const assignedIds = new Set(result.assigned.map((d) => d.queueId));
    expect(assignedIds.has(pr1)).toBe(true);
    expect(assignedIds.has(scaf)).toBe(true);
    // PR-2..4 still queued.
    expect(result.metrics.queueDepth).toBe(3);
  });

  it('higher priority_tier jumps the FIFO head', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    allocator.enqueue('pr_env', { pr: 1 });
    clock.advance(1000);
    const urgent = allocator.enqueue('pr_env', { pr: 99 }, { priorityTier: 10 });

    const result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([urgent]);
  });
});

describe('preemption rules — scaffold never evicts pr_env', () => {
  it('scaffold request does not change running pr_env slots', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0, // no dedicated scaffold slots so overflow is the only path
      overflowSlots: 0,
    });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();
    expect(slotStatus(db, 'pr-1')).toBe('busy');
    const prContainer = boundContainer(db, 'pr-1');

    // Pile on scaffold requests — they should never touch pr-1.
    allocator.enqueue('scaffold', { template: 'a' });
    allocator.enqueue('scaffold', { template: 'b' });
    const result = allocator.tick();

    expect(result.assigned).toHaveLength(0);
    expect(slotStatus(db, 'pr-1')).toBe('busy');
    expect(boundContainer(db, 'pr-1')).toBe(prContainer);
    // Scaffold requests are still queued waiting for capacity.
    expect(result.metrics.queueDepth).toBe(2);
  });
});

describe('overflow slot contention — pr_env wins immediately, scaffold waits', () => {
  it('pr_env head takes overflow before any scaffold, regardless of enqueue order', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    // Scaffold was enqueued first — FIFO would favour it — but PR envs win
    // overflow unconditionally.
    const scaf = allocator.enqueue('scaffold', { template: 't' });
    clock.advance(1000);
    const pr = allocator.enqueue('pr_env', { pr: 1 });

    const result = allocator.tick();
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]).toMatchObject({
      queueId: pr,
      class: 'pr_env',
      slotId: 'overflow-1',
      assignedAsOverflow: true,
    });
    // Scaffold is still queued and waiting.
    expect(result.scaffoldWaiting).toBe(1);
    void scaf;
  });

  it('pr_env that arrives mid-wait steals overflow from a waiting scaffold', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    allocator.enqueue('scaffold', { template: 't' });
    // Not yet past the bounded wait — scaffold should NOT take overflow.
    clock.advance(60_000);
    let result = allocator.tick();
    expect(result.assigned).toHaveLength(0);
    expect(result.scaffoldWaiting).toBe(1);

    // PR env arrives — grabs overflow on the next tick.
    const pr = allocator.enqueue('pr_env', { pr: 1 });
    result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([pr]);
    expect(result.assigned[0].slotId).toBe('overflow-1');
  });
});

describe('bounded-wait timeout — scaffold waits ≤120s then takes overflow', () => {
  it('scaffold is held back while waitMs < 120_000', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
      scaffoldOverflowWaitMs: 120_000,
    });
    allocator.enqueue('scaffold', { template: 't' });

    // Tick at t+0 — not waited long enough.
    let result = allocator.tick();
    expect(result.assigned).toHaveLength(0);
    expect(result.scaffoldWaiting).toBe(1);

    // Tick just before the boundary — still held.
    clock.advance(119_999);
    result = allocator.tick();
    expect(result.assigned).toHaveLength(0);
    expect(result.scaffoldWaiting).toBe(1);
  });

  it('scaffold claims overflow exactly at the 120_000 ms boundary', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
      scaffoldOverflowWaitMs: 120_000,
    });
    const scaf = allocator.enqueue('scaffold', { template: 't' });

    clock.advance(120_000);
    const result = allocator.tick();
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]).toMatchObject({
      queueId: scaf,
      class: 'scaffold',
      slotId: 'overflow-1',
      assignedAsOverflow: true,
    });
    expect(result.scaffoldWaiting).toBe(0);
  });

  it('uses the configured wait window (10 ms for a fast test)', () => {
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
      scaffoldOverflowWaitMs: 10,
    });
    allocator.enqueue('scaffold', { template: 't' });
    expect(allocator.tick().assigned).toHaveLength(0);

    clock.advance(10);
    expect(allocator.tick().assigned).toHaveLength(1);
  });
});

describe('metrics snapshots', () => {
  it('reports pool utilisation as busy-or-reserved over total slots', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 2,
      scaffoldSlots: 1,
      overflowSlots: 1,
    });
    // 0/4 busy to start.
    expect(allocator.snapshotMetrics().poolUtil).toBe(0);

    allocator.enqueue('pr_env', { pr: 1 });
    allocator.enqueue('pr_env', { pr: 2 });
    allocator.tick();
    // 2/4 busy.
    expect(allocator.snapshotMetrics().poolUtil).toBe(0.5);

    allocator.release('pr-1');
    // 1/4 busy.
    expect(allocator.snapshotMetrics().poolUtil).toBe(0.25);
    void db;
  });

  it('queue_depth counts only status=queued rows', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 1,
      scaffoldSlots: 0,
      overflowSlots: 0,
    });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.enqueue('pr_env', { pr: 2 });
    allocator.enqueue('pr_env', { pr: 3 });
    // 3 queued, 0 dispatched.
    expect(allocator.snapshotMetrics().queueDepth).toBe(3);

    allocator.tick();
    // 1 bound (removed from queue), 2 still queued.
    expect(allocator.snapshotMetrics().queueDepth).toBe(2);
    void db;
  });

  it('writeMetrics appends a pool_metrics row', () => {
    const { allocator, db } = freshAllocator();
    allocator.enqueue('pr_env', { pr: 1 });
    const result = allocator.tick();
    allocator.writeMetrics(result.metrics);

    const rows = db
      .prepare('SELECT pool_util, queue_depth, evictions, reaps FROM pool_metrics')
      .all() as Array<{
      pool_util: number;
      queue_depth: number;
      evictions: number;
      reaps: number;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].pool_util).toBeGreaterThan(0);
    expect(rows[0].queue_depth).toBe(0);
    expect(rows[0].evictions).toBe(0);
    expect(rows[0].reaps).toBe(0);
  });
});

describe('quota-violation lifecycle — slot moves to failed, is held out of dispatch', () => {
  function oomReason(containerId = 'c-oom'): import('./docker-lifecycle.js').ExitReason {
    return {
      kind: 'oom',
      exitCode: 137,
      oomKilled: true,
      message: 'container OOM-killed (mem_limit exceeded, exit 137)',
      containerId,
      finishedAt: '2026-04-19T12:00:00Z',
    };
  }

  function pidsReason(containerId = 'c-pids'): import('./docker-lifecycle.js').ExitReason {
    return {
      kind: 'pids',
      exitCode: 1,
      oomKilled: false,
      message: 'container hit pids_limit (fork/exec: EAGAIN)',
      containerId,
    };
  }

  it('handleContainerExit moves the slot to failed on OOM and records the reason', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();
    expect(slotStatus(db, 'pr-1')).toBe('busy');

    const terminal = allocator.handleContainerExit('pr-1', oomReason());
    expect(terminal).toBe('failed');
    expect(slotStatus(db, 'pr-1')).toBe('failed');

    // container_id is cleared so the UNIQUE(container_id) constraint
    // doesn't block a future rebind after reclaim.
    expect(boundContainer(db, 'pr-1')).toBeNull();

    const err = allocator.getSlotError('pr-1');
    expect(err).not.toBeNull();
    expect(err?.kind).toBe('oom');
    expect(err?.oomKilled).toBe(true);
    expect(err?.exitCode).toBe(137);
  });

  it('pids_limit violation is also treated as a quota violation (failed)', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();

    allocator.handleContainerExit('pr-1', pidsReason());
    expect(slotStatus(db, 'pr-1')).toBe('failed');
    expect(allocator.getSlotError('pr-1')?.kind).toBe('pids');
  });

  it('clean exit releases the slot back to free (no error recorded)', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();

    const terminal = allocator.handleContainerExit('pr-1', {
      kind: 'clean',
      exitCode: 0,
      oomKilled: false,
      message: 'container exited cleanly',
      containerId: 'c-clean',
    });
    expect(terminal).toBe('free');
    expect(slotStatus(db, 'pr-1')).toBe('free');
    expect(allocator.getSlotError('pr-1')).toBeNull();
  });

  it('plain crash also releases the slot — retry policy is job-level, not slot-level', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();

    const terminal = allocator.handleContainerExit('pr-1', {
      kind: 'crash',
      exitCode: 2,
      oomKilled: false,
      message: 'container exited 2: segfault',
      containerId: 'c-crash',
    });
    expect(terminal).toBe('free');
    expect(slotStatus(db, 'pr-1')).toBe('free');
  });

  it('a failed slot is held out of the dispatch pool until reclaimed', () => {
    const { allocator, db } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();
    allocator.handleContainerExit('pr-1', oomReason());
    expect(slotStatus(db, 'pr-1')).toBe('failed');

    // A new PR env request must NOT land on the failed slot — we don't
    // want to silently rebind onto a known-broken runtime.
    const pr2 = allocator.enqueue('pr_env', { pr: 2 });
    const result = allocator.tick();
    expect(result.assigned).toHaveLength(0);
    expect(result.prEnvWaiting).toBe(1);
    void pr2;

    // Reclaim the slot — now the queued request can dispatch.
    expect(allocator.reclaimFailedSlot('pr-1')).toBe(true);
    expect(slotStatus(db, 'pr-1')).toBe('free');
    expect(allocator.getSlotError('pr-1')).toBeNull();

    const result2 = allocator.tick();
    expect(result2.assigned).toHaveLength(1);
    expect(result2.assigned[0].slotId).toBe('pr-1');
  });

  it('reclaimFailedSlot is a no-op on slots that are not in the failed state', () => {
    const { allocator } = freshAllocator({ prEnvSlots: 1, scaffoldSlots: 0, overflowSlots: 0 });
    // Busy slot — reclaim must not clobber the live binding.
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();
    expect(allocator.reclaimFailedSlot('pr-1')).toBe(false);

    // Unknown slot — returns false rather than throwing.
    expect(allocator.reclaimFailedSlot('does-not-exist')).toBe(false);
  });

  it('failed slots count as "not free" in pool_util — they still consume the fleet', () => {
    const { allocator } = freshAllocator({ prEnvSlots: 2, scaffoldSlots: 0, overflowSlots: 0 });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.tick();
    // 1/2 busy.
    expect(allocator.snapshotMetrics().poolUtil).toBe(0.5);

    allocator.handleContainerExit('pr-1', oomReason());
    // Still 1/2 "in use" — failed slots are out of rotation until
    // reclaimed, which is the right utilization signal for alerting.
    expect(allocator.snapshotMetrics().poolUtil).toBe(0.5);
  });
});

describe('startDispatcher — 1 Hz tick driver', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls allocator.tick() every intervalMs', () => {
    const { allocator } = freshAllocator();
    const spy = vi.spyOn(allocator, 'tick');

    const stop = startDispatcher(allocator, { intervalMs: 1000, metricsEveryNTicks: 999 });
    try {
      vi.advanceTimersByTime(3500);
      expect(spy).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it('writes metrics every N ticks, not every tick', () => {
    const { allocator } = freshAllocator();
    const writeSpy = vi.spyOn(allocator, 'writeMetrics');

    const stop = startDispatcher(allocator, { intervalMs: 1000, metricsEveryNTicks: 3 });
    try {
      vi.advanceTimersByTime(7000);
      // 7 ticks → writeMetrics called on tick 3 and tick 6 → 2 calls.
      expect(writeSpy).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('swallows tick errors via onError so the loop keeps running', () => {
    const { allocator } = freshAllocator();
    const err = new Error('boom');
    vi.spyOn(allocator, 'tick').mockImplementation(() => {
      throw err;
    });
    const onError = vi.fn();

    const stop = startDispatcher(allocator, { intervalMs: 1000, onError });
    try {
      vi.advanceTimersByTime(2500);
      expect(onError).toHaveBeenCalledTimes(2);
      expect(onError).toHaveBeenLastCalledWith(err);
    } finally {
      stop();
    }
  });
});
