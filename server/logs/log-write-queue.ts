/**
 * log-write-queue.ts — the single bounded batch-writer queue in front of
 * logs.db (decision LOG-STORE: "one bounded in-process batch-writer queue").
 *
 * Ingest requests do not write SQLite inline. They normalize + validate
 * synchronously (so oversize / batch-overflow rejections are still reported in
 * the response), then hand the surviving records to this queue and return. A
 * background flusher drains the queue in bounded batches, coalescing a burst of
 * many small requests into a few larger write transactions — the point is to
 * stop a burst from fsync-thrashing the writer and to bound the in-memory
 * backlog so a hostile sender can't exhaust the Hub's heap.
 *
 * Two explicit bounds (both operator-configurable via env):
 *   - **queue depth** (`maxQueueRecords`) — when a batch would overflow it, the
 *     WHOLE batch is refused and reported as `dropped`; the ingest route turns
 *     that into 429 backpressure so the source app gets a clean retry signal
 *     rather than silent partial loss.
 *   - **flush limit** (`maxFlushRecords`) — the most records drained into one
 *     write transaction, so a large backlog drains across ticks instead of one
 *     event-loop-blocking commit.
 *
 * A flush that throws (disk full, IO error) discards its batch (counted as
 * `dropped` + `writeErrors`) rather than requeueing it — requeueing a
 * permanently-failing batch would grow the queue without bound and re-throw
 * forever. Logging must never crash the Hub or the source app.
 */

import type { LogRecordInput } from './logs-db.js';
import { insertLogRecords } from './logs-db.js';
import {
  DEFAULT_WRITE_QUEUE_MAX_RECORDS,
  DEFAULT_WRITE_QUEUE_FLUSH_RECORDS,
  DEFAULT_WRITE_QUEUE_FLUSH_INTERVAL_MS,
} from './logs-schema.js';
import { incLogMetric, recordLogFlush } from './log-metrics.js';

/** The store write the queue drives; injectable so tests can force failures. */
export type LogWriteFn = (
  records: LogRecordInput[],
  nowMs: number,
) => { inserted: number; rejectedOversize: number };

export interface LogWriteQueueOptions {
  maxQueueRecords?: number;
  maxFlushRecords?: number;
  /** Background flush cadence in ms; `0` disables the timer (manual drain). */
  flushIntervalMs?: number;
  writeFn?: LogWriteFn;
  /** Clock injection for deterministic latency accounting in tests. */
  now?: () => number;
}

export interface EnqueueResult {
  /** Records admitted to the queue (0 when the batch was refused whole). */
  enqueued: number;
  /** Records refused because the queue was at its depth cap (backpressure). */
  dropped: number;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

export class LogWriteQueue {
  private readonly queue: LogRecordInput[] = [];
  private readonly maxQueueRecords: number;
  private readonly maxFlushRecords: number;
  private readonly flushIntervalMs: number;
  private readonly writeFn: LogWriteFn;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: LogWriteQueueOptions = {}) {
    this.maxQueueRecords = positiveInt(opts.maxQueueRecords, DEFAULT_WRITE_QUEUE_MAX_RECORDS);
    this.maxFlushRecords = positiveInt(opts.maxFlushRecords, DEFAULT_WRITE_QUEUE_FLUSH_RECORDS);
    // 0 is a valid explicit "no timer" (tests / manual drain); only an
    // undefined/negative value falls back to the default cadence.
    this.flushIntervalMs =
      opts.flushIntervalMs === 0
        ? 0
        : positiveInt(opts.flushIntervalMs, DEFAULT_WRITE_QUEUE_FLUSH_INTERVAL_MS);
    this.writeFn = opts.writeFn ?? insertLogRecords;
    this.now = opts.now ?? Date.now;
  }

  /** Current pending record count. */
  size(): number {
    return this.queue.length;
  }

  get depthLimit(): number {
    return this.maxQueueRecords;
  }

  /**
   * Admit a batch. All-or-nothing against the depth cap: if the whole batch
   * does not fit, none are enqueued and the count is reported as `dropped`.
   */
  enqueue(records: LogRecordInput[]): EnqueueResult {
    if (records.length === 0) return { enqueued: 0, dropped: 0 };
    if (this.queue.length + records.length > this.maxQueueRecords) {
      incLogMetric('dropped', records.length);
      return { enqueued: 0, dropped: records.length };
    }
    for (const r of records) this.queue.push(r);
    incLogMetric('accepted', records.length);
    this.ensureTimer();
    return { enqueued: records.length, dropped: 0 };
  }

  /**
   * Drain up to `maxFlushRecords` in one write transaction. Never throws — a
   * failed write is absorbed as `dropped` + `writeErrors`. Returns records
   * actually committed.
   */
  flushOnce(): number {
    if (this.queue.length === 0) return 0;
    const batch = this.queue.splice(0, this.maxFlushRecords);
    const start = this.now();
    try {
      const result = this.writeFn(batch, start);
      recordLogFlush(result.inserted, this.now() - start);
      // Any record the store itself refused (defense-in-depth oversize guard)
      // is a silent drop — it was already counted `accepted` on enqueue.
      if (result.rejectedOversize > 0) incLogMetric('dropped', result.rejectedOversize);
      return result.inserted;
    } catch (err) {
      incLogMetric('writeErrors');
      incLogMetric('dropped', batch.length);
      console.warn('[log-write-queue] flush failed, dropping batch:', (err as Error).message);
      return 0;
    }
  }

  /** Flush the whole backlog in bounded batches. Returns total records written. */
  drain(): number {
    let total = 0;
    // Bound the loop by the starting backlog so a writeFn that somehow grows
    // the queue can never spin here.
    let guard = Math.ceil(this.queue.length / this.maxFlushRecords) + 1;
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
    // Never keep the process alive just for the log flusher.
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }
}

// ─── Process-wide singleton ─────────────────────────────────────────────────

let singleton: LogWriteQueue | null = null;

function envInt(name: string): number | undefined {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
}

/** The shared queue, built from env overrides on first use. */
export function getLogWriteQueue(): LogWriteQueue {
  if (!singleton) {
    singleton = new LogWriteQueue({
      maxQueueRecords: envInt('LOG_WRITE_QUEUE_MAX_RECORDS'),
      maxFlushRecords: envInt('LOG_WRITE_QUEUE_FLUSH_RECORDS'),
      flushIntervalMs: envInt('LOG_WRITE_QUEUE_FLUSH_INTERVAL_MS'),
    });
  }
  return singleton;
}

/** Admit records into the shared queue (ingest hot path). */
export function enqueueLogRecords(records: LogRecordInput[]): EnqueueResult {
  return getLogWriteQueue().enqueue(records);
}

/** Force-drain the shared queue (graceful shutdown + deterministic tests). */
export function flushLogWriteQueue(): number {
  return singleton ? singleton.drain() : 0;
}

/** Start the shared queue's background flusher (server boot). */
export function startLogWriteQueue(): void {
  getLogWriteQueue().start();
}

/** Stop the shared queue's background flusher (shutdown). */
export function stopLogWriteQueue(): void {
  if (singleton) singleton.stop();
}

/** Test hook: drop the singleton so the next `getLogWriteQueue()` re-reads env. */
export function resetLogWriteQueueForTests(): void {
  if (singleton) {
    singleton.stop();
    singleton = null;
  }
}
