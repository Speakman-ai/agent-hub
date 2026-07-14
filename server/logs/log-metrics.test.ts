import { describe, it, expect, beforeEach } from 'vitest';
import {
  incLogMetric,
  recordLogFlush,
  getLogMetrics,
  meanFlushLatencyMs,
  resetLogMetrics,
} from './log-metrics.js';

beforeEach(() => resetLogMetrics());

describe('log-metrics counters', () => {
  it('starts zeroed', () => {
    const m = getLogMetrics();
    expect(m.accepted).toBe(0);
    expect(m.dropped).toBe(0);
    expect(m.writeErrors).toBe(0);
  });

  it('accumulates counter increments', () => {
    incLogMetric('accepted', 5);
    incLogMetric('accepted');
    incLogMetric('rejected', 2);
    incLogMetric('redacted', 3);
    const m = getLogMetrics();
    expect(m.accepted).toBe(6);
    expect(m.rejected).toBe(2);
    expect(m.redacted).toBe(3);
  });

  it('tracks WebSocket subscriber drops, starting from zero', () => {
    expect(getLogMetrics().wsDrops).toBe(0);
    incLogMetric('wsDrops');
    incLogMetric('wsDrops');
    expect(getLogMetrics().wsDrops).toBe(2);
  });

  it('ignores non-positive / non-finite deltas', () => {
    incLogMetric('dropped', 0);
    incLogMetric('dropped', -4);
    incLogMetric('dropped', Number.NaN);
    expect(getLogMetrics().dropped).toBe(0);
  });

  it('records flush record-count into `written` and averages latency', () => {
    recordLogFlush(100, 10);
    recordLogFlush(50, 30);
    const m = getLogMetrics();
    expect(m.written).toBe(150);
    expect(m.flushCount).toBe(2);
    expect(meanFlushLatencyMs(m)).toBe(20); // (10 + 30) / 2
  });

  it('returns 0 mean latency before any flush', () => {
    expect(meanFlushLatencyMs(getLogMetrics())).toBe(0);
  });

  it('getLogMetrics returns a copy, not a live reference', () => {
    const snap = getLogMetrics();
    incLogMetric('accepted', 9);
    expect(snap.accepted).toBe(0);
    expect(getLogMetrics().accepted).toBe(9);
  });

  it('resetLogMetrics zeroes everything', () => {
    incLogMetric('accepted', 3);
    recordLogFlush(10, 5);
    resetLogMetrics();
    const m = getLogMetrics();
    expect(m.accepted).toBe(0);
    expect(m.written).toBe(0);
    expect(m.flushCount).toBe(0);
  });
});
