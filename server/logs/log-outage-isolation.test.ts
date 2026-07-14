/**
 * log-outage-isolation.test.ts — a logging outage must never degrade the source
 * application or the rest of the Hub (decision LOG-STORE: "never let logging
 * failure block the source application or exhaust the Hub's memory/disk").
 *
 * The customer log store is isolated from operational state by construction:
 * it lives in its own logs.db and behind a bounded batch-writer queue, and the
 * chat / board / Finalize paths never call the ingest hot path. What a unit test
 * can prove is the containment contract at that seam:
 *   - a write that throws (disk full, IO error) is absorbed, not propagated;
 *   - a full queue applies backpressure by returning `dropped`, never throwing;
 *   - a broken live-tail transport can never fail the committed writer;
 *   - the backlog is bounded, so a hostile/failing sender cannot grow the heap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { LogWriteQueue, type LogWriteFn } from './log-write-queue.js';
import { publishLogTail, subscribeLogTail, resetLogTailListenersForTests } from './log-tail.js';
import { getLogMetrics, resetLogMetrics } from './log-metrics.js';
import { SEVERITY_NUMBER } from './logs-schema.js';
import type { LogRecordInput } from './logs-db.js';

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

const recs = (n: number): LogRecordInput[] => Array.from({ length: n }, (_, i) => rec(`m${i}`));

beforeEach(() => {
  resetLogMetrics();
  resetLogTailListenersForTests();
});

afterEach(() => {
  resetLogTailListenersForTests();
});

describe('a failing writer is contained (disk full / IO error)', () => {
  it('absorbs a throwing write as writeErrors + dropped without propagating', () => {
    const diskFull: LogWriteFn = () => {
      throw new Error('SQLITE_FULL: database or disk is full');
    };
    const q = new LogWriteQueue({ flushIntervalMs: 0, writeFn: diskFull });

    // Enqueue must succeed even though the eventual write will fail.
    expect(() => q.enqueue(recs(5))).not.toThrow();
    // Draining must not throw into the caller — the failure is swallowed.
    let written = 0;
    expect(() => {
      written = q.drain();
    }).not.toThrow();
    expect(written).toBe(0);

    const m = getLogMetrics();
    expect(m.writeErrors).toBeGreaterThanOrEqual(1);
    expect(m.dropped).toBe(5);
    // A permanently-failing batch is discarded, not requeued — the queue drains
    // to empty rather than growing without bound.
    expect(q.size()).toBe(0);
  });
});

describe('backpressure is signalled, not thrown', () => {
  it('refuses an over-capacity batch by returning dropped rather than throwing', () => {
    const ok: LogWriteFn = (records) => ({ inserted: records.length, rejectedOversize: 0 });
    const q = new LogWriteQueue({ maxQueueRecords: 10, flushIntervalMs: 0, writeFn: ok });

    expect(q.enqueue(recs(8))).toEqual({ enqueued: 8, dropped: 0 });
    // The next batch would overflow the depth cap: the WHOLE batch is refused.
    const result = q.enqueue(recs(5));
    expect(result).toEqual({ enqueued: 0, dropped: 5 });
    expect(q.size()).toBe(8); // backlog stays bounded at the cap
    expect(getLogMetrics().dropped).toBe(5);
  });
});

describe('a broken live-tail transport cannot fail the writer', () => {
  it('swallows a throwing tail listener so the committed write still returns', () => {
    const good = vi.fn();
    subscribeLogTail(() => {
      throw new Error('subscriber socket exploded');
    });
    subscribeLogTail(good);

    // publishLogTail runs on the post-commit path; a listener throwing must not
    // bubble out (it would otherwise crash the writer holding committed rows).
    expect(() =>
      publishLogTail([
        {
          id: 1,
          project_id: 'proj-a',
          source_id: 'src-1',
          time_unix_nano: 1,
          observed_time_unix_nano: null,
          severity_number: 9,
          severity_text: null,
          body: 'live',
          service_name: null,
          environment: null,
          trace_id: null,
          span_id: null,
          fingerprint: null,
          resource_json: null,
          attributes_json: null,
          scope_json: null,
          byte_size: 4,
          ingested_at: 1,
        },
      ]),
    ).not.toThrow();
    // The healthy subscriber still received the batch despite its sibling
    // throwing — one broken transport cannot starve the others.
    expect(good).toHaveBeenCalledTimes(1);
  });
});
