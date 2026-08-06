import { describe, expect, it } from 'vitest';
import {
  RANGE_OPTIONS,
  buildMetricBars,
  formatPeriod,
  formatValue,
  normalizeValueRange,
  seriesKey,
  type InfraAlarmSegment,
  type InfraMetricPoint,
} from './infraMetrics';

const point = (tsMs: number, value: number): InfraMetricPoint => ({ tsMs, value, count: 1 });

describe('normalizeValueRange', () => {
  it('pads a constant series so the scale is not a divide by zero', () => {
    const { minValue, maxValue, valueSpan } = normalizeValueRange([5, 5, 5]);
    expect(valueSpan).toBeGreaterThan(0);
    expect(minValue).toBeLessThan(5);
    expect(maxValue).toBeGreaterThan(5);
    // A flat series sits mid-plot rather than on an edge.
    expect((5 - minValue) / valueSpan).toBeCloseTo(0.5);
  });

  it('pads a large constant proportionally rather than by a fixed 1', () => {
    const { valueSpan } = normalizeValueRange([1000, 1000]);
    expect(valueSpan).toBeCloseTo(200);
  });

  it('spans a varying series exactly, with no padding', () => {
    expect(normalizeValueRange([2, 8])).toMatchObject({ minValue: 2, maxValue: 8, valueSpan: 6 });
  });

  it('falls back to a usable range when there is nothing to scale', () => {
    const { valueSpan } = normalizeValueRange([]);
    expect(valueSpan).toBeGreaterThan(0);
  });

  it('ignores non-finite values instead of poisoning the range with NaN', () => {
    expect(normalizeValueRange([1, Number.NaN, 3, Number.POSITIVE_INFINITY])).toMatchObject({
      minValue: 1,
      maxValue: 3,
    });
  });
});

describe('buildMetricBars', () => {
  it('buckets points into a fixed column count regardless of point count', () => {
    const points = Array.from({ length: 500 }, (_, i) => point(i * 10, i));
    const { bars } = buildMetricBars(points, [], 0, 5000, 20);
    expect(bars).toHaveLength(20);
  });

  it('keeps an empty bucket as a zero-height gap rather than closing it up', () => {
    // Two points at the far ends of a four-column window; the middle collected
    // nothing and must still occupy its columns.
    const { bars, hasData } = buildMetricBars([point(0, 10), point(900, 10)], [], 0, 1000, 4);
    expect(hasData).toBe(true);
    expect(bars.map((b) => b.value !== null)).toEqual([true, false, false, true]);
    expect(bars[1].height).toBe(0);
    expect(bars[2].height).toBe(0);
  });

  it('averages the points that land in the same bucket', () => {
    const { bars } = buildMetricBars([point(10, 0), point(20, 10)], [], 0, 100, 1);
    expect(bars[0].value).toBe(5);
  });

  it('clamps the point on the right edge into the last bucket', () => {
    // `toMs` itself divides to exactly `columns`, one past the last index. The
    // newest datapoint is the one being watched, so it is clamped back in
    // rather than dropped.
    const { bars } = buildMetricBars([point(1000, 7)], [], 0, 1000, 4);
    expect(bars[3].value).toBe(7);
  });

  it('drops points outside the window', () => {
    const { bars, hasData } = buildMetricBars([point(-50, 1), point(5000, 1)], [], 0, 1000, 4);
    expect(hasData).toBe(false);
    expect(bars.every((b) => b.value === null)).toBe(true);
  });

  it('reports ALARM for a bucket that spans both a breach and a recovery', () => {
    // The whole window is one bucket; an OK segment listed first must not hide
    // the ALARM segment that shares it.
    const segments: InfraAlarmSegment[] = [
      { alertId: 'a1', ruleId: 'r1', state: 'OK', startMs: 0, endMs: 500 },
      { alertId: 'a1', ruleId: 'r1', state: 'ALARM', startMs: 500, endMs: 1000 },
    ];
    const { bars } = buildMetricBars([point(10, 1)], segments, 0, 1000, 1);
    expect(bars[0].state).toBe('ALARM');
  });

  it('leaves a bucket unshaded when no segment overlaps it', () => {
    const segments: InfraAlarmSegment[] = [
      { alertId: 'a1', ruleId: 'r1', state: 'ALARM', startMs: 0, endMs: 250 },
    ];
    const { bars } = buildMetricBars([], segments, 0, 1000, 4);
    expect(bars[0].state).toBe('ALARM');
    expect(bars[3].state).toBeNull();
  });

  it('never emits a NaN height for a flat series', () => {
    const { bars } = buildMetricBars([point(10, 4), point(20, 4)], [], 0, 100, 2);
    for (const bar of bars) {
      expect(Number.isNaN(bar.height)).toBe(false);
      expect(bar.height).toBeGreaterThanOrEqual(0);
      expect(bar.height).toBeLessThanOrEqual(1);
    }
  });

  it('survives a zero-width window without dividing by zero', () => {
    const { bars } = buildMetricBars([point(0, 1)], [], 500, 500, 4);
    expect(bars).toHaveLength(4);
    expect(bars.every((b) => Number.isFinite(b.height))).toBe(true);
  });
});

describe('formatters', () => {
  it('abbreviates large values and keeps precision on small ones', () => {
    expect(formatValue(2_500_000)).toBe('2.5M');
    expect(formatValue(1500)).toBe('1.5k');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(4.21)).toBe('4.2');
    expect(formatValue(0.125)).toBe('0.13');
    expect(formatValue(Number.NaN)).toBe('—');
  });

  it('names a period without recomputing one', () => {
    expect(formatPeriod(30)).toBe('30s');
    expect(formatPeriod(300)).toBe('5m');
    expect(formatPeriod(3600)).toBe('1h');
    expect(formatPeriod(0)).toBe('—');
  });

  it('builds a stable series identity from every distinguishing field', () => {
    const base = {
      namespace: 'AWS/EC2',
      metricName: 'CPUUtilization',
      stat: 'Average',
      periodSeconds: 300,
      dimensionsHash: 'abc',
      pointCount: 1,
      firstTsMs: 0,
      lastTsMs: 1,
    };
    // A different statistic on the same metric is a different series.
    expect(seriesKey({ ...base, stat: 'Maximum' })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, periodSeconds: 60 })).not.toBe(seriesKey(base));
    expect(seriesKey({ ...base, dimensionsHash: 'def' })).not.toBe(seriesKey(base));
  });

  it('cannot collide two series whose fields contain the separator', () => {
    // Regression guard on the separator choice: AWS metric names and namespaces
    // may contain spaces, so a printable separator would fold these two
    // distinct series into one key and the picker would show a single option.
    const base = {
      stat: 'Average',
      periodSeconds: 300,
      dimensionsHash: 'abc',
      pointCount: 1,
      firstTsMs: 0,
      lastTsMs: 1,
    };
    expect(seriesKey({ ...base, namespace: 'A B', metricName: 'C' })).not.toBe(
      seriesKey({ ...base, namespace: 'A', metricName: 'B C' }),
    );
  });

  it('offers the same windows the web range picker does', () => {
    expect(RANGE_OPTIONS.map((o) => o.label)).toEqual(['1h', '6h', '24h', '7d', '30d', '90d']);
  });
});
