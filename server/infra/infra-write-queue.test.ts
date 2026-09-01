/**
 * Batched metric-point writer: flush thresholds, depth-cap backpressure, error
 * absorption, the commit-then-publish contract, and an end-to-end pass against
 * a real infra.db including overlap idempotence through the queue.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initInfraDb, closeInfraDb, infraResourceKey, INFRA_CHECKPOINT_LABEL } from './infra-db.js';
import { __setWalPressureForTests } from '../db-checkpoint.js';
import {
  countInfraMetricPoints,
  queryInfraMetricPoints,
  type InfraMetricPointInput,
  type InfraMetricPointRow,
} from './infra-metric-store.js';
import {
  InfraWriteQueue,
  enqueueInfraMetricPoints,
  flushInfraWriteQueue,
  getInfraWriteQueue,
  resetInfraWriteQueueForTests,
  resetInfraMetricWriteListenersForTests,
  subscribeInfraMetricWrites,
  type InfraWriteFn,
} from './infra-write-queue.js';

const RESOURCE = infraResourceKey({
  projectId: 'proj-a',
  accountId: '111122223333',
  region: 'us-east-1',
  service: 'ec2',
  resourceId: 'i-0abc',
});

function point(tsMs: number, over: Partial<InfraMetricPointInput> = {}): InfraMetricPointInput {
  return {
    projectId: 'proj-a',
    resourceKey: RESOURCE,
    namespace: 'AWS/EC2',
    metricName: 'CPUUtilization',
    stat: 'Average',
    periodSeconds: 60,
    tsMs,
    value: tsMs,
    ...over,
  };
}

function points(n: number, startMs = 0): InfraMetricPointInput[] {
  return Array.from({ length: n }, (_, i) => point(startMs + (i + 1) * 60_000));
}

/** A writeFn that records the batch sizes it was handed. */
function recordingWriteFn(): { fn: InfraWriteFn; batches: number[] } {
  const batches: number[] = [];
  const fn: InfraWriteFn = (batch) => {
    batches.push(batch.length);
    return { inserted: batch.length, rejected: 0 };
  };
  return { fn, batches };
}

describe('InfraWriteQueue — bounds and flushing', () => {
  it('coalesces a burst and drains it in flush-limit batches', () => {
    const { fn, batches } = recordingWriteFn();
    const q = new InfraWriteQueue({ maxFlushPoints: 100, flushIntervalMs: 0, writeFn: fn });

    expect(q.enqueue(points(250))).toEqual({ enqueued: 250, dropped: 0 });
    // Nothing written yet — the collector tick did not pay for a commit.
    expect(batches).toEqual([]);
    expect(q.size()).toBe(250);

    expect(q.flushOnce()).toBe(100);
    expect(q.flushOnce()).toBe(100);
    expect(q.flushOnce()).toBe(50);
    expect(q.flushOnce()).toBe(0);
    expect(batches).toEqual([100, 100, 50]);
    expect(q.size()).toBe(0);
  });

  it('drain() empties the whole backlog in one call', () => {
    const { fn, batches } = recordingWriteFn();
    const q = new InfraWriteQueue({ maxFlushPoints: 100, flushIntervalMs: 0, writeFn: fn });
    q.enqueue(points(250));
    expect(q.drain()).toBe(250);
    expect(batches).toEqual([100, 100, 50]);
    expect(q.size()).toBe(0);
  });

  it('refuses a whole batch at the depth cap rather than admitting part of it', () => {
    const { fn } = recordingWriteFn();
    const q = new InfraWriteQueue({ maxQueuePoints: 5, flushIntervalMs: 0, writeFn: fn });

    expect(q.enqueue(points(3))).toEqual({ enqueued: 3, dropped: 0 });
    // A partial admit would leave a hole in the middle of a series that reads
    // exactly like real missing data to the alert evaluator.
    expect(q.enqueue(points(3, 1_000_000))).toEqual({ enqueued: 0, dropped: 3 });
    expect(q.size()).toBe(3);
    expect(q.getStats().dropped).toBe(3);
    expect(q.getStats().accepted).toBe(3);
    expect(q.depthLimit).toBe(5);
  });

  it('admits a batch again once the backlog has drained below the cap', () => {
    const { fn } = recordingWriteFn();
    const q = new InfraWriteQueue({ maxQueuePoints: 5, flushIntervalMs: 0, writeFn: fn });
    q.enqueue(points(5));
    expect(q.enqueue(points(1, 1_000_000)).dropped).toBe(1);
    q.drain();
    expect(q.enqueue(points(1, 1_000_000))).toEqual({ enqueued: 1, dropped: 0 });
  });

  it('absorbs a throwing writeFn without taking the collector down', () => {
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: () => {
        throw new Error('SQLITE_FULL: database or disk is full');
      },
    });
    q.enqueue(points(10));
    expect(() => q.flushOnce()).not.toThrow();
    // The batch is discarded, never requeued — a permanently-failing batch
    // would grow the queue without bound.
    expect(q.size()).toBe(0);
    expect(q.getStats().writeErrors).toBe(1);
    expect(q.getStats().dropped).toBe(10);
    expect(q.getStats().written).toBe(0);
  });

  it('counts store-side rejections without counting them as written', () => {
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: (batch) => ({ inserted: batch.length - 2, rejected: 2 }),
    });
    q.enqueue(points(10));
    q.drain();
    expect(q.getStats().written).toBe(8);
    expect(q.getStats().rejected).toBe(2);
  });

  it('flushes on the background timer and stops once drained', () => {
    vi.useFakeTimers();
    try {
      const { fn, batches } = recordingWriteFn();
      const q = new InfraWriteQueue({ maxFlushPoints: 100, flushIntervalMs: 250, writeFn: fn });
      q.enqueue(points(150));
      expect(batches).toEqual([]);

      vi.advanceTimersByTime(250);
      expect(batches).toEqual([100]);
      vi.advanceTimersByTime(250);
      expect(batches).toEqual([100, 50]);

      // Timer self-stops when the backlog empties; no idle interval remains.
      vi.advanceTimersByTime(2_000);
      expect(batches).toEqual([100, 50]);
      q.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records flush latency from the injected clock', () => {
    let t = 0;
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      now: () => (t += 5),
      writeFn: (batch) => ({ inserted: batch.length, rejected: 0 }),
    });
    q.enqueue(points(3));
    q.flushOnce();
    const stats = q.getStats();
    expect(stats.flushCount).toBe(1);
    expect(stats.flushMillis).toBe(5);
  });

  it('treats an empty enqueue as a no-op', () => {
    const { fn, batches } = recordingWriteFn();
    const q = new InfraWriteQueue({ flushIntervalMs: 0, writeFn: fn });
    expect(q.enqueue([])).toEqual({ enqueued: 0, dropped: 0 });
    expect(q.drain()).toBe(0);
    expect(batches).toEqual([]);
  });
});

describe('committed-write publication', () => {
  afterEach(() => resetInfraMetricWriteListenersForTests());

  it('publishes only rows the store returned from inside its transaction', () => {
    const seen: InfraMetricPointRow[][] = [];
    subscribeInfraMetricWrites((p) => seen.push(p));

    const committed: InfraMetricPointRow[] = [
      {
        id: 1,
        projectId: 'proj-a',
        resourceKey: RESOURCE,
        namespace: 'AWS/EC2',
        metricName: 'CPUUtilization',
        dimensionsHash: '-',
        dimensionsJson: null,
        stat: 'Average',
        periodSeconds: 60,
        tsMs: 60_000,
        value: 1,
      },
    ];
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: () => ({ inserted: 1, rejected: 0, points: committed }),
    });
    q.enqueue(points(1));
    q.drain();
    expect(seen).toEqual([committed]);
  });

  it('stays silent when the writer reports no committed rows', () => {
    const seen: InfraMetricPointRow[][] = [];
    subscribeInfraMetricWrites((p) => seen.push(p));
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: (batch) => ({ inserted: batch.length, rejected: 0 }),
    });
    q.enqueue(points(3));
    q.drain();
    expect(seen).toEqual([]);
  });

  it('publishes nothing when the write transaction throws', () => {
    const seen: InfraMetricPointRow[][] = [];
    subscribeInfraMetricWrites((p) => seen.push(p));
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: () => {
        throw new Error('rolled back');
      },
    });
    q.enqueue(points(3));
    q.drain();
    expect(seen).toEqual([]);
  });

  it('survives a listener that throws', () => {
    const seen: number[] = [];
    subscribeInfraMetricWrites(() => {
      throw new Error('broken consumer');
    });
    subscribeInfraMetricWrites((p) => seen.push(p.length));
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: () => ({
        inserted: 1,
        rejected: 0,
        points: [{ id: 1 } as unknown as InfraMetricPointRow],
      }),
    });
    q.enqueue(points(1));
    expect(() => q.drain()).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('stops delivering after unsubscribe', () => {
    const seen: number[] = [];
    const off = subscribeInfraMetricWrites((p) => seen.push(p.length));
    const q = new InfraWriteQueue({
      flushIntervalMs: 0,
      writeFn: () => ({
        inserted: 1,
        rejected: 0,
        points: [{ id: 1 } as unknown as InfraMetricPointRow],
      }),
    });
    q.enqueue(points(1));
    q.drain();
    off();
    q.enqueue(points(1, 500_000));
    q.drain();
    expect(seen).toEqual([1]);
  });
});

describe('shared queue singleton — end-to-end against infra.db', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'infra-queue-test-'));
    initInfraDb(dir);
    resetInfraWriteQueueForTests();
    // Manual drain keeps the test deterministic; the timer is exercised above.
    process.env.INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS = '0';
  });

  afterEach(() => {
    delete process.env.INFRA_WRITE_QUEUE_FLUSH_INTERVAL_MS;
    delete process.env.INFRA_WRITE_QUEUE_MAX_POINTS;
    delete process.env.INFRA_WRITE_QUEUE_FLUSH_POINTS;
    resetInfraWriteQueueForTests();
    resetInfraMetricWriteListenersForTests();
    closeInfraDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defers the write off the collector path, then persists on drain', () => {
    expect(enqueueInfraMetricPoints(points(4))).toEqual({ enqueued: 4, dropped: 0 });
    expect(countInfraMetricPoints('proj-a')).toBe(0);

    expect(flushInfraWriteQueue()).toBe(4);
    expect(countInfraMetricPoints('proj-a')).toBe(4);
  });

  it('stays idempotent when an overlapping window is re-enqueued', () => {
    enqueueInfraMetricPoints(points(4));
    flushInfraWriteQueue();
    // Same window plus two more datapoints, as a retry would produce.
    enqueueInfraMetricPoints(points(6));
    flushInfraWriteQueue();
    expect(countInfraMetricPoints('proj-a')).toBe(6);
  });

  it('publishes committed rows to subscribers with their durable ids', () => {
    const seen: InfraMetricPointRow[] = [];
    subscribeInfraMetricWrites((p) => seen.push(...p));
    enqueueInfraMetricPoints(points(2));
    flushInfraWriteQueue();

    expect(seen).toHaveLength(2);
    expect(seen.every((p) => Number.isInteger(p.id) && p.id > 0)).toBe(true);

    const stored = queryInfraMetricPoints({
      projectId: 'proj-a',
      resourceKey: RESOURCE,
      metricName: 'CPUUtilization',
      startMs: 0,
      endMs: 10_000_000,
    });
    expect(stored.map((r) => r.id).sort()).toEqual(seen.map((p) => p.id).sort());
  });

  it('reads its bounds from env on first use', () => {
    resetInfraWriteQueueForTests();
    process.env.INFRA_WRITE_QUEUE_MAX_POINTS = '5';
    process.env.INFRA_WRITE_QUEUE_FLUSH_POINTS = '2';

    const q = getInfraWriteQueue();
    expect(q.depthLimit).toBe(5);
    expect(enqueueInfraMetricPoints(points(6)).dropped).toBe(6);
    expect(enqueueInfraMetricPoints(points(5))).toEqual({ enqueued: 5, dropped: 0 });
    expect(flushInfraWriteQueue()).toBe(5);
    expect(countInfraMetricPoints('proj-a')).toBe(5);
  });

  it('flushInfraWriteQueue is safe before the singleton exists', () => {
    resetInfraWriteQueueForTests();
    expect(flushInfraWriteQueue()).toBe(0);
  });

  it('sheds points while infra.db WAL is under pressure, then admits again on release', () => {
    resetInfraWriteQueueForTests();
    __setWalPressureForTests(INFRA_CHECKPOINT_LABEL, true);
    try {
      expect(enqueueInfraMetricPoints(points(3))).toEqual({ enqueued: 0, dropped: 3 });
      __setWalPressureForTests(INFRA_CHECKPOINT_LABEL, false);
      expect(enqueueInfraMetricPoints(points(2)).enqueued).toBe(2);
    } finally {
      __setWalPressureForTests(INFRA_CHECKPOINT_LABEL, false);
      resetInfraWriteQueueForTests();
    }
  });
});
