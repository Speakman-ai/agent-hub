/**
 * Container pool allocator + dispatcher (W1).
 *
 * Implements the scheduling half of the container-pool spec (wiki page
 * "Container Pool — PR Envs + Scaffolding", §2 two-queue design and §4
 * preemption rules). Actual container spawn/reap is out of scope — this
 * module is the pure accounting layer over `pool_slots`, `pool_queue`,
 * and `pool_metrics`.
 *
 * Shape:
 *
 *   PoolAllocator — manages slot accounting, enqueue, release, and a
 *                   single `tick()` call that performs one dispatch pass.
 *                   All time comes from an injectable `Clock` so tests can
 *                   use Vitest fake timers.
 *
 *   startDispatcher — thin wrapper that drives `tick()` on a fixed 1 Hz
 *                     interval in production. Returns a stop function.
 *
 * Contract highlights (see wiki §1.4, §2.2 for full prose):
 *
 *   • Two independent FIFO queues: `pr_env` and `scaffold`. Queue ordering
 *     is (priority_tier DESC, enqueued_at ASC); for W1 every request comes
 *     in at priority_tier = 0, so this collapses to plain FIFO.
 *
 *   • Scaffolding NEVER preempts a running PR env. There is no eviction
 *     path for scaffold requests; they queue or fall through to overflow.
 *
 *   • PR envs MAY briefly block scaffolding. When a scaffold request is
 *     queued and the overflow slot is free, the allocator holds overflow
 *     open for up to `scaffoldOverflowWaitMs` (default 120 000 ms) in case
 *     a PR env request arrives — scaffold only claims overflow after it
 *     has been waiting that long. This preserves the priority ordering
 *     (long-lived > short-lived) without letting scaffolds starve.
 *
 *   • The shared overflow slot is assigned per tick: PR-env head wins
 *     unconditionally, scaffold head wins only after the bounded wait.
 *
 *   • `priority_tier` index decision (W1): deferred. All requests pin to
 *     tier 0 until the enterprise opt-out lands, so the existing
 *     `(status, enqueued_at)` composite index already answers the
 *     dispatcher's hot-path query with a single scan. Adding
 *     `priority_tier DESC` now would cost an index write on every enqueue
 *     for zero benefit — revisit in the same migration that introduces
 *     tier > 0 rows.
 */

import type { Database } from 'better-sqlite3';
import { randomUUID } from 'crypto';

export type QueueClass = 'pr_env' | 'scaffold';
export type SlotClass = QueueClass | 'overflow';
export type SlotStatus = 'free' | 'reserved' | 'busy' | 'draining';
export type QueueStatus = 'queued' | 'dispatching' | 'failed';

export interface Clock {
  /** Monotonic-ish wall clock, ms since epoch. Used for bounded-wait math. */
  nowMs(): number;
  /**
   * ISO-ish timestamp suitable for SQLite TEXT columns. Matches the format
   * `datetime('now')` produces so rows enqueued via default clauses and
   * rows inserted by this module sort consistently.
   */
  nowIso(): string;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString().slice(0, 19).replace('T', ' '),
};

export interface AllocatorConfig {
  /** Dedicated PR-env slots (spec §1.3 target: 8). */
  prEnvSlots: number;
  /** Dedicated scaffold slots (spec §1.3 target: 3). */
  scaffoldSlots: number;
  /** Shared overflow slots (spec §1.3: 1). */
  overflowSlots: number;
  /**
   * How long a scaffold request must have been queued before it is allowed
   * to claim the overflow slot. PR-env requests bypass this wait. Default
   * 120 000 ms per spec §1.4.
   */
  scaffoldOverflowWaitMs: number;
}

export const DEFAULT_CONFIG: AllocatorConfig = {
  prEnvSlots: 8,
  scaffoldSlots: 3,
  overflowSlots: 1,
  scaffoldOverflowWaitMs: 120_000,
};

/** One successful queue→slot binding produced by `tick()`. */
export interface DispatchDecision {
  queueId: string;
  class: QueueClass;
  slotId: string;
  /** True if the binding consumed an overflow slot rather than a dedicated one. */
  assignedAsOverflow: boolean;
}

export interface TickMetrics {
  /** Busy+reserved+draining slots / total slots, clamped to [0,1]. */
  poolUtil: number;
  /** Sum of rows in `pool_queue` with status='queued' across both classes. */
  queueDepth: number;
  /** Evictions performed this tick (W1 is queue-only — always 0). */
  evictions: number;
  /** Reaps performed this tick (W1 is queue-only — always 0). */
  reaps: number;
}

export interface TickResult {
  assigned: DispatchDecision[];
  /**
   * Number of queued scaffold requests that were held back because the
   * bounded wait had not yet elapsed. Surfaced so the dispatcher can log
   * a "scaffold waiting on PR envs" counter without re-querying.
   */
  scaffoldWaiting: number;
  /** Number of pr_env queue rows still queued at end of tick. */
  prEnvWaiting: number;
  metrics: TickMetrics;
}

interface QueueRow {
  id: string;
  class: QueueClass;
  payload: string;
  priority_tier: number;
  enqueued_at: string;
  enqueued_ms: number;
  status: QueueStatus;
}

interface SlotRow {
  slot_id: string;
  class: SlotClass;
  status: SlotStatus;
  container_id: string | null;
}

/**
 * Parse a timestamp written by either `datetime('now')` (SQLite default,
 * `YYYY-MM-DD HH:MM:SS`) or our own `nowIso()` helper into ms. Falls back
 * to the current clock if the value is malformed — bounded-wait checks
 * treat unparseable timestamps as "just enqueued" which is the safe
 * direction (they wait the full window rather than jumping the queue).
 */
function parseEnqueuedMs(raw: string, clock: Clock): number {
  // SQLite's datetime('now') emits UTC without a trailing 'Z'; Date()
  // will parse that as local time, so we normalise to ISO-with-Z first.
  const normalised = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  if (Number.isFinite(parsed)) return parsed;
  return clock.nowMs();
}

export class PoolAllocator {
  private readonly db: Database;
  private readonly config: AllocatorConfig;
  private readonly clock: Clock;

  constructor(db: Database, options: { config?: Partial<AllocatorConfig>; clock?: Clock } = {}) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) };
    this.clock = options.clock ?? systemClock;
  }

  /**
   * Seed `pool_slots` with the configured fleet (pr-1..N, scaffold-1..M,
   * overflow-1..K). Safe to call repeatedly — existing rows are preserved
   * so a restart doesn't clobber live bindings.
   */
  init(): void {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pool_slots (slot_id, class, status) VALUES (?, ?, ?)',
    );
    const seed = this.db.transaction(() => {
      for (let i = 1; i <= this.config.prEnvSlots; i++) {
        insert.run(`pr-${i}`, 'pr_env', 'free');
      }
      for (let i = 1; i <= this.config.scaffoldSlots; i++) {
        insert.run(`scaffold-${i}`, 'scaffold', 'free');
      }
      for (let i = 1; i <= this.config.overflowSlots; i++) {
        insert.run(`overflow-${i}`, 'overflow', 'free');
      }
    });
    seed();
  }

  /**
   * Append a work item to the relevant queue. Returns the row id so the
   * caller can correlate it with future metrics / webhook status.
   */
  enqueue(
    class_: QueueClass,
    payload: unknown,
    options: { id?: string; priorityTier?: number; enqueuedAt?: string } = {},
  ): string {
    const id = options.id ?? randomUUID();
    const enqueuedAt = options.enqueuedAt ?? this.clock.nowIso();
    const serialised = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.db
      .prepare(
        `INSERT INTO pool_queue (id, class, payload, priority_tier, enqueued_at, status)
         VALUES (?, ?, ?, ?, ?, 'queued')`,
      )
      .run(id, class_, serialised, options.priorityTier ?? 0, enqueuedAt);
    return id;
  }

  /**
   * Mark a slot as free and clear its binding. Called by the (future)
   * container lifecycle layer when a container exits — for W1 tests use
   * it to simulate a slot becoming available mid-scenario.
   */
  release(slotId: string): void {
    this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'free',
                container_id = NULL,
                started_at = NULL,
                last_activity_at = NULL
          WHERE slot_id = ?`,
      )
      .run(slotId);
  }

  /**
   * Run a single dispatch pass. The caller decides the cadence — prod uses
   * `startDispatcher(this, 1000)`, tests call `tick()` directly between
   * `vi.advanceTimersByTime()` steps.
   */
  tick(): TickResult {
    const assigned: DispatchDecision[] = [];

    // Everything mutating runs in a single transaction so a concurrent
    // enqueue can't observe a half-assigned state.
    const run = this.db.transaction(() => {
      // 1. Fill dedicated PR env slots FIFO.
      for (;;) {
        const slot = this.findFreeSlot('pr_env');
        if (!slot) break;
        const head = this.popQueueHead('pr_env');
        if (!head) break;
        this.bind(slot.slot_id, head.id);
        assigned.push({
          queueId: head.id,
          class: 'pr_env',
          slotId: slot.slot_id,
          assignedAsOverflow: false,
        });
      }

      // 2. Fill dedicated scaffold slots FIFO.
      for (;;) {
        const slot = this.findFreeSlot('scaffold');
        if (!slot) break;
        const head = this.popQueueHead('scaffold');
        if (!head) break;
        this.bind(slot.slot_id, head.id);
        assigned.push({
          queueId: head.id,
          class: 'scaffold',
          slotId: slot.slot_id,
          assignedAsOverflow: false,
        });
      }

      // 3. Overflow assignment. PR env heads win outright; scaffold heads
      //    only claim overflow after the bounded wait so a late-arriving
      //    PR env can still get the slot.
      for (;;) {
        const overflow = this.findFreeSlot('overflow');
        if (!overflow) break;

        const prHead = this.peekQueueHead('pr_env');
        if (prHead) {
          this.popQueueHead('pr_env'); // consume the head we just peeked
          this.bind(overflow.slot_id, prHead.id);
          assigned.push({
            queueId: prHead.id,
            class: 'pr_env',
            slotId: overflow.slot_id,
            assignedAsOverflow: true,
          });
          continue;
        }

        const scafHead = this.peekQueueHead('scaffold');
        if (!scafHead) break;

        const waitedMs = this.clock.nowMs() - scafHead.enqueued_ms;
        if (waitedMs < this.config.scaffoldOverflowWaitMs) {
          // Head hasn't aged into overflow eligibility yet; leave it and
          // everything behind it queued. Bail out of the overflow loop —
          // later heads are strictly younger so they can't be eligible
          // either.
          break;
        }

        this.popQueueHead('scaffold');
        this.bind(overflow.slot_id, scafHead.id);
        assigned.push({
          queueId: scafHead.id,
          class: 'scaffold',
          slotId: overflow.slot_id,
          assignedAsOverflow: true,
        });
      }
    });
    run();

    const metrics = this.snapshotMetrics();
    return {
      assigned,
      scaffoldWaiting: this.countQueued('scaffold'),
      prEnvWaiting: this.countQueued('pr_env'),
      metrics,
    };
  }

  /**
   * Append a row to `pool_metrics`. Called from the dispatcher at the same
   * cadence as `tick()` — kept separate so callers can throttle metric
   * writes (e.g. every 60 ticks) without skipping dispatches.
   */
  writeMetrics(metrics: TickMetrics, timestamp: string = this.clock.nowIso()): void {
    this.db
      .prepare(
        `INSERT INTO pool_metrics (timestamp, pool_util, queue_depth, evictions, reaps)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(timestamp, metrics.poolUtil, metrics.queueDepth, metrics.evictions, metrics.reaps);
  }

  /** Expose metrics without mutating state — used by tests and observability. */
  snapshotMetrics(): TickMetrics {
    const total = (this.db.prepare('SELECT COUNT(*) AS n FROM pool_slots').get() as { n: number })
      .n;
    const busy = (
      this.db.prepare("SELECT COUNT(*) AS n FROM pool_slots WHERE status <> 'free'").get() as {
        n: number;
      }
    ).n;
    const queueDepth = (
      this.db.prepare("SELECT COUNT(*) AS n FROM pool_queue WHERE status = 'queued'").get() as {
        n: number;
      }
    ).n;

    const poolUtil = total === 0 ? 0 : busy / total;
    return {
      poolUtil: Math.min(1, Math.max(0, poolUtil)),
      queueDepth,
      // W1 has no eviction / reap path yet. W2 will plumb real counts
      // through by threading an accumulator into tick().
      evictions: 0,
      reaps: 0,
    };
  }

  // ─── internals ────────────────────────────────────────────────────────

  private findFreeSlot(class_: SlotClass): SlotRow | null {
    const row = this.db
      .prepare(
        `SELECT slot_id, class, status, container_id FROM pool_slots
          WHERE class = ? AND status = 'free'
          ORDER BY slot_id ASC LIMIT 1`,
      )
      .get(class_) as SlotRow | undefined;
    return row ?? null;
  }

  private peekQueueHead(class_: QueueClass): QueueRow | null {
    const row = this.db
      .prepare(
        `SELECT id, class, payload, priority_tier, enqueued_at, status
           FROM pool_queue
          WHERE status = 'queued' AND class = ?
          ORDER BY priority_tier DESC, enqueued_at ASC
          LIMIT 1`,
      )
      .get(class_) as Omit<QueueRow, 'enqueued_ms'> | undefined;
    if (!row) return null;
    return { ...row, enqueued_ms: parseEnqueuedMs(row.enqueued_at, this.clock) };
  }

  private popQueueHead(class_: QueueClass): QueueRow | null {
    const head = this.peekQueueHead(class_);
    if (!head) return null;
    // Deleting the row is simpler than a `dispatching` state for W1 — once
    // a slot has been bound the queue item has served its purpose. W2 can
    // promote this to a soft-delete if we need post-hoc request timing.
    this.db.prepare('DELETE FROM pool_queue WHERE id = ?').run(head.id);
    return head;
  }

  private countQueued(class_: QueueClass): number {
    return (
      this.db
        .prepare("SELECT COUNT(*) AS n FROM pool_queue WHERE status = 'queued' AND class = ?")
        .get(class_) as { n: number }
    ).n;
  }

  private bind(slotId: string, queueId: string): void {
    const ts = this.clock.nowIso();
    this.db
      .prepare(
        `UPDATE pool_slots
            SET status = 'busy',
                container_id = ?,
                started_at = ?,
                last_activity_at = ?
          WHERE slot_id = ?`,
      )
      .run(queueId, ts, ts, slotId);
  }
}

/**
 * Drive `allocator.tick()` on a fixed interval. Returns a stop function.
 * Errors inside a tick are caught and logged so a single bad row can't
 * take down the dispatcher — PM2 will still restart on a hard crash.
 */
export function startDispatcher(
  allocator: PoolAllocator,
  options: {
    intervalMs?: number;
    metricsEveryNTicks?: number;
    onError?: (err: unknown) => void;
  } = {},
): () => void {
  const intervalMs = options.intervalMs ?? 1000;
  const metricsEvery = options.metricsEveryNTicks ?? 60;
  const onError = options.onError ?? ((err) => console.error('[container-pool] tick failed', err));

  let ticks = 0;
  const timer = setInterval(() => {
    try {
      const result = allocator.tick();
      ticks++;
      if (ticks % metricsEvery === 0) {
        allocator.writeMetrics(result.metrics);
      }
    } catch (err) {
      onError(err);
    }
  }, intervalMs);

  // Don't block process exit on a running dispatcher — matches the
  // heartbeat / cron runners elsewhere in the server.
  if (typeof timer.unref === 'function') timer.unref();

  return () => clearInterval(timer);
}
