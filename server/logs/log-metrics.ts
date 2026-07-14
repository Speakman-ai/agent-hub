/**
 * log-metrics.ts — in-process health counters for the customer log store
 * (decision LOG-SCOPE: "Publish health metrics for accepted/dropped records,
 * queue depth, write latency, database bytes, retention lag, redaction
 * counts").
 *
 * One process-wide counter set, incremented on the ingest → queue → writer →
 * reaper path and read back by `GET /api/projects/:projectId/logs/metrics`.
 * Counters are monotonic since boot (and since the last `resetLogMetrics()`);
 * point-in-time gauges (queue depth, db bytes, retention lag) are resolved at
 * read time by the metrics route, not stored here, so this module stays a pure
 * accumulator with no DB or timer dependency.
 *
 * Deliberately global rather than per-project: there is a single batch-writer
 * queue and a single logs.db, so accepted/dropped/queue/write throughput are
 * hub-wide quantities. Per-project storage bytes and retention lag are computed
 * from the store at read time.
 */

export interface LogMetricsSnapshot {
  /** Records admitted into the write queue (accepted for persistence). */
  accepted: number;
  /** Records actually committed to logs.db by the writer. */
  written: number;
  /** Records rejected synchronously pre-queue (oversize or batch overflow). */
  rejected: number;
  /**
   * Records discarded without being written — queue-full backpressure or a
   * failed write transaction (disk full, IO error). Distinct from `rejected`,
   * which is a bounded/validation refusal the caller sees per-request.
   */
  dropped: number;
  /** Secret substrings / keys masked before persistence. */
  redacted: number;
  /** Flush transactions that threw (disk/IO error). */
  writeErrors: number;
  /** Records deleted by the retention (age) reaper pass. */
  expiredDeleted: number;
  /** Records evicted by the per-project quota reaper pass. */
  quotaDeleted: number;
  /** Cumulative writer flush wall-time, ms (for an average-latency readout). */
  flushMillis: number;
  /** Number of flush transactions counted into `flushMillis`. */
  flushCount: number;
}

const counters: LogMetricsSnapshot = freshCounters();

function freshCounters(): LogMetricsSnapshot {
  return {
    accepted: 0,
    written: 0,
    rejected: 0,
    dropped: 0,
    redacted: 0,
    writeErrors: 0,
    expiredDeleted: 0,
    quotaDeleted: 0,
    flushMillis: 0,
    flushCount: 0,
  };
}

/** Add `n` (default 1) to a counter. Negative/non-finite deltas are ignored. */
export function incLogMetric(key: keyof LogMetricsSnapshot, n = 1): void {
  if (!Number.isFinite(n) || n <= 0) return;
  counters[key] += n;
}

/** Record one completed flush: its record count and wall-time. */
export function recordLogFlush(records: number, millis: number): void {
  if (records > 0) counters.written += records;
  if (Number.isFinite(millis) && millis >= 0) {
    counters.flushMillis += millis;
    counters.flushCount += 1;
  }
}

/** Immutable copy of the current counters. */
export function getLogMetrics(): LogMetricsSnapshot {
  return { ...counters };
}

/** Mean flush latency in ms across all counted flushes (0 when none yet). */
export function meanFlushLatencyMs(snapshot: LogMetricsSnapshot = counters): number {
  return snapshot.flushCount > 0 ? snapshot.flushMillis / snapshot.flushCount : 0;
}

/** Test hook: zero every counter. */
export function resetLogMetrics(): void {
  Object.assign(counters, freshCounters());
}
