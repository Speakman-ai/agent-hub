import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  LogWriteQueue,
  enqueueLogRecords,
  flushLogWriteQueue,
  resetLogWriteQueueForTests,
  type LogWriteFn,
} from './log-write-queue.js';
import {
  initLogsDb,
  closeLogsDb,
  queryLogRecords,
  LOGS_CHECKPOINT_LABEL,
  type LogRecordInput,
} from './logs-db.js';
import { getLogMetrics, resetLogMetrics } from './log-metrics.js';
import { SEVERITY_NUMBER } from './logs-schema.js';
import { __setWalPressureForTests } from '../db-checkpoint.js';

function rec(body: string): LogRecordInput {
  return {
    projectId: 'proj-a',
    sourceId: 'src-1',
    timeUnixNano: 1_800_000_000_000 * 1_000_000,
    severityNumber: SEVERITY_NUMBER.INFO,
    body,
    byteSize: body.length,
  };
}

function recs(n: number): LogRecordInput[] {
  return Array.from({ length: n }, (_, i) => rec(`m${i}`));
}

/** A writeFn that records how many records each flush saw and "persists" them. */
function recordingWriteFn(): { fn: LogWriteFn; batches: number[]; total: () => number } {
  const batches: number[] = [];
  const fn: LogWriteFn = (records) => {
    batches.push(records.length);
    return { inserted: records.length, rejectedOversize: 0 };
  };
  return { fn, batches, total: () => batches.reduce((a, b) => a + b, 0) };
}

beforeEach(() => {
  resetLogMetrics();
});

describe('LogWriteQueue — bounds and flushing', () => {
  it('coalesces a burst and drains it in bounded flush-limit batches', () => {
    const { fn, batches, total } = recordingWriteFn();
    const q = new LogWriteQueue({
      maxFlushRecords: 100,
      maxQueueRecords: 10_000,
      flushIntervalMs: 0,
      writeFn: fn,
    });

    q.enqueue(recs(250));
    expect(q.size()).toBe(250); // nothing written until a flush (deferred)

    expect(q.flushOnce()).toBe(100);
    expect(q.flushOnce()).toBe(100);
    expect(q.flushOnce()).toBe(50);
    expect(q.flushOnce()).toBe(0); // empty

    expect(batches).toEqual([100, 100, 50]); // never more than the flush limit
    expect(total()).toBe(250);
    expect(getLogMetrics().accepted).toBe(250);
    expect(getLogMetrics().written).toBe(250);
  });

  it('drain() empties the whole backlog in one call', () => {
    const { fn, total } = recordingWriteFn();
    const q = new LogWriteQueue({ maxFlushRecords: 64, flushIntervalMs: 0, writeFn: fn });
    q.enqueue(recs(200));
    expect(q.drain()).toBe(200);
    expect(q.size()).toBe(0);
    expect(total()).toBe(200);
  });

  it('refuses a whole batch when the depth cap would overflow (queue-full backpressure)', () => {
    const { fn } = recordingWriteFn();
    const q = new LogWriteQueue({ maxQueueRecords: 5, flushIntervalMs: 0, writeFn: fn });

    expect(q.enqueue(recs(3))).toEqual({ enqueued: 3, dropped: 0 });
    // 3 + 3 > 5 → the whole second batch is refused (all-or-nothing).
    expect(q.enqueue(recs(3))).toEqual({ enqueued: 0, dropped: 3 });
    expect(q.size()).toBe(3);

    const m = getLogMetrics();
    expect(m.accepted).toBe(3);
    expect(m.dropped).toBe(3);
  });

  it('absorbs a failing write (disk full / IO error) without throwing and drops the batch', () => {
    const boom: LogWriteFn = () => {
      throw new Error('SQLITE_FULL: database or disk is full');
    };
    const q = new LogWriteQueue({ maxFlushRecords: 100, flushIntervalMs: 0, writeFn: boom });
    q.enqueue(recs(10));

    expect(() => q.flushOnce()).not.toThrow();
    expect(q.size()).toBe(0); // failed batch is discarded, not requeued forever

    const m = getLogMetrics();
    expect(m.writeErrors).toBe(1);
    expect(m.dropped).toBe(10);
    expect(m.written).toBe(0);
  });

  it('runs a background flusher on its interval and stops when drained', () => {
    vi.useFakeTimers();
    try {
      const { fn, total } = recordingWriteFn();
      const q = new LogWriteQueue({ maxFlushRecords: 1000, flushIntervalMs: 250, writeFn: fn });
      q.enqueue(recs(3));
      expect(q.size()).toBe(3);
      vi.advanceTimersByTime(250);
      expect(q.size()).toBe(0);
      expect(total()).toBe(3);
      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an empty enqueue as a no-op', () => {
    const { fn } = recordingWriteFn();
    const q = new LogWriteQueue({ flushIntervalMs: 0, writeFn: fn });
    expect(q.enqueue([])).toEqual({ enqueued: 0, dropped: 0 });
    expect(q.size()).toBe(0);
  });
});

describe('shared queue singleton — end-to-end against logs.db (restart/persistence)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'log-queue-test-'));
    initLogsDb(dir);
    resetLogWriteQueueForTests();
    process.env.LOG_WRITE_QUEUE_FLUSH_INTERVAL_MS = '0'; // manual drain only
  });

  afterEach(() => {
    delete process.env.LOG_WRITE_QUEUE_FLUSH_INTERVAL_MS;
    resetLogWriteQueueForTests();
    closeLogsDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists enqueued records through the real store on drain (graceful-shutdown flush)', () => {
    const res = enqueueLogRecords([rec('queued-a'), rec('queued-b')]);
    expect(res).toEqual({ enqueued: 2, dropped: 0 });
    // Nothing on disk yet — the write is deferred.
    expect(queryLogRecords({ projectId: 'proj-a', limit: 10 }).records).toHaveLength(0);

    // Simulate the shutdown drain.
    expect(flushLogWriteQueue()).toBe(2);
    const rows = queryLogRecords({ projectId: 'proj-a', limit: 10 }).records;
    expect(rows.map((r) => r.body).sort()).toEqual(['queued-a', 'queued-b']);
  });
});

describe('enqueueLogRecords WAL backpressure', () => {
  beforeEach(() => {
    resetLogWriteQueueForTests();
    resetLogMetrics();
  });
  afterEach(() => {
    __setWalPressureForTests(LOGS_CHECKPOINT_LABEL, false);
    resetLogWriteQueueForTests();
    resetLogMetrics();
  });

  it('sheds the batch (counted dropped) while logs.db WAL is under pressure', () => {
    __setWalPressureForTests(LOGS_CHECKPOINT_LABEL, true);
    expect(enqueueLogRecords([rec('a'), rec('b')])).toEqual({ enqueued: 0, dropped: 2 });
    expect(getLogMetrics().dropped).toBeGreaterThanOrEqual(2);

    // Released → admitted again (into the in-memory queue).
    __setWalPressureForTests(LOGS_CHECKPOINT_LABEL, false);
    expect(enqueueLogRecords([rec('c')]).enqueued).toBe(1);
  });
});
