/**
 * infra-write-queue.ts — the single bounded batch-writer queue in front of
 * `infra_metric_points` (decision INFRA-STORE: "Writes go through a batch queue
 * modeled on server/logs/log-write-queue.ts so a collector tick never blocks on
 * synchronous SQLite writes").
 *
 * A collector tick can return tens of thousands of datapoints across up to 500
 * GetMetricData queries. Writing those inline would park the tick on fsync for
 * the length of the commit and hold the write lock against every concurrent
 * chart read. The tick instead hands its points here and returns; a background
 * flusher drains them in bounded transactions.
 *
 * Two explicit bounds, both operator-configurable via env:
 *   - **queue depth** (`maxQueuePoints`) — when a batch would overflow it, the
 *     WHOLE batch is refused and reported as `dropped`. All-or-nothing matters
 *     here: a partially-admitted tick would leave a hole in the middle of a
 *     series that looks exactly like a real gap, and the alert evaluator treats
 *     gaps as missing data. Refusing whole makes the loss legible, and the
 *     window is re-collectable from CloudWatch on the next tick anyway.
 *   - **flush limit** (`maxFlushPoints`) — the most points drained into one
 *     write transaction, so a large backlog drains across ticks instead of one
 *     event-loop-blocking commit.
 *
 * A flush that throws (disk full, IO error) discards its batch rather than
 * requeueing it: a permanently-failing batch would grow the queue without bound
 * and re-throw forever. Monitoring must never take the Hub down with it.
 */

import {
  insertInfraMetricPoints,
  type InfraMetricPointInput,
  type InfraMetricPointRow,
} from './infra-metric-store.js';
import {
  DEFAULT_INFRA_WRITE_QUEUE_MAX_POINTS,
  DEFAULT_INFRA_WRITE_QUEUE_FLUSH_POINTS,
  DEFAULT_INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS,
} from './infra-schema.js';
import { isWalUnderPressureLabel } from '../db-checkpoint.js';
import { INFRA_CHECKPOINT_LABEL } from './infra-db.js';

/** The store write the queue drives; injectable so tests can force failures. */
export type InfraWriteFn = (points: InfraMetricPointInput[]) => {
  inserted: number;
  rejected: number;
  points?: InfraMetricPointRow[];
};

export interface InfraWriteQueueOptions {
  maxQueuePoints?: number;
  maxFlushPoints?: number;
  /** Background flush cadence in ms; `0` disables the timer (manual drain). */
  flushIntervalMs?: number;
  writeFn?: InfraWriteFn;
  /** Clock injection for deterministic latency accounting in tests. */
  now?: () => number;
}

export interface InfraEnqueueResult {
  /** Points admitted to the queue (0 when the batch was refused whole). */
  enqueued: number;
  /** Points refused because the queue was at its depth cap (backpressure). */
  dropped: number;
}

/** Monotonic counters since process start (or the last stats reset). */
export interface InfraWriteQueueStats {
  /** Points admitted into the queue. */
  accepted: number;
  /** Points durably committed by the writer. */
  written: number;
  /** Points refused by the store's own validation during a flush. */
  rejected: number;
  /** Points discarded — depth-cap backpressure or a failed write transaction. */
  dropped: number;
  /** Flush transactions that threw. */
  writeErrors: number;
  /** Cumulative writer flush wall-time, ms. */
  flushMillis: number;
  /** Number of flush transactions counted into `flushMillis`. */
  flushCount: number;
}

/**
 * Called with the rows a flush durably committed. Registered listeners are the
 * alert evaluator's hook (decision INFRA-ALERT); they never see a point that a
 * rolled-back transaction failed to write.
 */
export type InfraMetricWriteListener = (points: InfraMetricPointRow[]) => void;

const listeners = new Set<InfraMetricWriteListener>();

/** Subscribe to committed metric writes. Returns an unsubscribe function. */
export function subscribeInfraMetricWrites(fn: InfraMetricWriteListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test hook: drop every subscriber. */
export function resetInfraMetricWriteListenersForTests(): void {
  listeners.clear();
}

function publishCommitted(points: InfraMetricPointRow[]): void {
  if (points.length === 0) return;
  for (const fn of listeners) {
    try {
      fn(points);
    } catch (err) {
      // A broken consumer must not fail the writer.
      console.warn('[infra-write-queue] listener threw:', (err as Error).message);
    }
  }
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function freshStats(): InfraWriteQueueStats {
  return {
    accepted: 0,
    written: 0,
    rejected: 0,
    dropped: 0,
    writeErrors: 0,
    flushMillis: 0,
    flushCount: 0,
  };
}

export class InfraWriteQueue {
  private readonly queue: InfraMetricPointInput[] = [];
  private readonly maxQueuePoints: number;
  private readonly maxFlushPoints: number;
  private readonly flushIntervalMs: number;
  private readonly writeFn: InfraWriteFn;
  private readonly now: () => number;
  private readonly stats: InfraWriteQueueStats = freshStats();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: InfraWriteQueueOptions = {}) {
    this.maxQueuePoints = positiveInt(opts.maxQueuePoints, DEFAULT_INFRA_WRITE_QUEUE_MAX_POINTS);
    this.maxFlushPoints = positiveInt(opts.maxFlushPoints, DEFAULT_INFRA_WRITE_QUEUE_FLUSH_POINTS);
    // 0 is a valid explicit "no timer" (tests / manual drain); only an
    // undefined/negative value falls back to the default cadence.
    this.flushIntervalMs =
      opts.flushIntervalMs === 0
        ? 0
        : positiveInt(opts.flushIntervalMs, DEFAULT_INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS);
    this.writeFn = opts.writeFn ?? insertInfraMetricPoints;
    this.now = opts.now ?? Date.now;
  }

  /** Current pending point count. */
  size(): number {
    return this.queue.length;
  }

  get depthLimit(): number {
    return this.maxQueuePoints;
  }

  /** Immutable copy of the counters. */
  getStats(): InfraWriteQueueStats {
    return { ...this.stats };
  }

  /**
   * Admit a batch. All-or-nothing against the depth cap: if the whole batch
   * does not fit, none are enqueued and the count is reported as `dropped`.
   */
  enqueue(points: InfraMetricPointInput[]): InfraEnqueueResult {
    if (points.length === 0) return { enqueued: 0, dropped: 0 };
    if (this.queue.length + points.length > this.maxQueuePoints) {
      this.stats.dropped += points.length;
      return { enqueued: 0, dropped: points.length };
    }
    for (const p of points) this.queue.push(p);
    this.stats.accepted += points.length;
    this.ensureTimer();
    return { enqueued: points.length, dropped: 0 };
  }

  /**
   * Drain up to `maxFlushPoints` in one write transaction. Never throws — a
   * failed write is absorbed as `dropped` + `writeErrors`. Returns the points
   * actually committed.
   */
  flushOnce(): number {
    if (this.queue.length === 0) return 0;
    const batch = this.queue.splice(0, this.maxFlushPoints);
    const start = this.now();
    try {
      const result = this.writeFn(batch);
      if (result.inserted > 0) this.stats.written += result.inserted;
      this.stats.flushMillis += Math.max(0, this.now() - start);
      this.stats.flushCount += 1;
      if (result.rejected > 0) this.stats.rejected += result.rejected;
      // Only rows the store returned from inside its transaction are published.
      // A test writer that omits `points` is deliberately transport-silent
      // rather than fabricating non-durable events.
      if (result.points?.length) publishCommitted(result.points);
      return result.inserted;
    } catch (err) {
      this.stats.writeErrors += 1;
      this.stats.dropped += batch.length;
      console.warn('[infra-write-queue] flush failed, dropping batch:', (err as Error).message);
      return 0;
    }
  }

  /** Flush the whole backlog in bounded batches. Returns total points written. */
  drain(): number {
    let total = 0;
    // Bound the loop by the starting backlog so a writeFn that somehow grows
    // the queue can never spin here.
    let guard = Math.ceil(this.queue.length / this.maxFlushPoints) + 1;
    while (this.queue.length > 0 && guard-- > 0) {
      total += this.flushOnce();
    }
    return total;
  }

  /** Begin (or keep) the background flush timer. */
  start(): void {
    this.ensureTimer();
  }

  /** Stop the background flush timer. Does not drain — call `drain()` first. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureTimer(): void {
    if (this.timer || this.flushIntervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.flushOnce();
        if (this.queue.length === 0) this.stop();
      } catch {
        // flushOnce never throws, but keep the timer callback bomb-proof.
      }
    }, this.flushIntervalMs);
    // Never keep the process alive just for the metric flusher.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

// ─── Process-wide singleton ─────────────────────────────────────────────────

let singleton: InfraWriteQueue | null = null;

function envInt(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
}

/** The shared queue, built from env overrides on first use. */
export function getInfraWriteQueue(): InfraWriteQueue {
  if (!singleton) {
    singleton = new InfraWriteQueue({
      maxQueuePoints: envInt('INFRA_WRITE_QUEUE_MAX_POINTS'),
      maxFlushPoints: envInt('INFRA_WRITE_QUEUE_FLUSH_POINTS'),
      flushIntervalMs: envInt('INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS'),
    });
  }
  return singleton;
}

/** Admit points into the shared queue (collector hot path). */
export function enqueueInfraMetricPoints(points: InfraMetricPointInput[]): InfraEnqueueResult {
  // WAL-pressure backpressure: if infra.db has grown past its hard limit and
  // cannot be checkpointed, shed the batch (same drop semantics as a full queue)
  // so the collector stops appending to — and growing — the WAL until it drains.
  if (points.length > 0 && isWalUnderPressureLabel(INFRA_CHECKPOINT_LABEL)) {
    return { enqueued: 0, dropped: points.length };
  }
  return getInfraWriteQueue().enqueue(points);
}

/** Force-drain the shared queue (graceful shutdown + deterministic tests). */
export function flushInfraWriteQueue(): number {
  return singleton ? singleton.drain() : 0;
}

/** Start the shared queue's background flusher (server boot). */
export function startInfraWriteQueue(): void {
  getInfraWriteQueue().start();
}

/** Stop the shared queue's background flusher (shutdown). */
export function stopInfraWriteQueue(): void {
  if (singleton) singleton.stop();
}

/** Test hook: drop the singleton so the next `getInfraWriteQueue()` re-reads env. */
export function resetInfraWriteQueueForTests(): void {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}
