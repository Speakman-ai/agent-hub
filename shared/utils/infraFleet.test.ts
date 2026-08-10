/**
 * Fleet formatting and sparkline geometry. The cases here are the ones where
 * the obvious implementation is wrong: a null that must not become a zero, a
 * byte count the RDS console shows in GB, and a flat series that divides by
 * zero if the scale is not padded.
 */
import { describe, it, expect } from 'vitest';
import {
  fleetResourceTitle,
  formatHeadlineValue,
  infraServiceLabel,
  sparklineFractions,
  sparklinePolyline,
  type InfraFleetResourceWire,
} from './infraFleet.js';

describe('formatHeadlineValue', () => {
  it('renders a missing reading as an em-dash rather than zero', () => {
    // The distinction the whole dashboard rests on: "collected, nothing came
    // back" is not "idle".
    expect(formatHeadlineValue(null, 'percent')).toBe('—');
    expect(formatHeadlineValue(Number.NaN, 'count')).toBe('—');
    expect(formatHeadlineValue(0, 'percent')).toBe('0.0%');
  });

  it('formats percentages tightly enough for a tile', () => {
    expect(formatHeadlineValue(42.4, 'percent')).toBe('42%');
    expect(formatHeadlineValue(3.14, 'percent')).toBe('3.1%');
  });

  it('scales bytes, which CloudWatch stores raw and the AWS console does not', () => {
    // A raw FreeableMemory figure reads a billion times off against the console.
    expect(formatHeadlineValue(1536, 'bytes')).toBe('1.5 KB');
    expect(formatHeadlineValue(1024 * 1024 * 1024 * 1.5, 'bytes')).toBe('1.5 GB');
    expect(formatHeadlineValue(512, 'bytes')).toBe('512 B');
    expect(formatHeadlineValue(-2048, 'bytes')).toBe('-2.0 KB');
  });

  it('keeps small counts exact and abbreviates large ones', () => {
    expect(formatHeadlineValue(3, 'count')).toBe('3');
    expect(formatHeadlineValue(0, 'count')).toBe('0');
    expect(formatHeadlineValue(1500, 'count')).toBe('1.5k');
    expect(formatHeadlineValue(2_500_000, 'count')).toBe('2.5M');
  });

  it('reads sub-second latencies in milliseconds', () => {
    expect(formatHeadlineValue(0.0123, 'seconds')).toBe('12ms');
    expect(formatHeadlineValue(2.5, 'seconds')).toBe('2.50s');
    expect(formatHeadlineValue(180, 'seconds')).toBe('3.0m');
  });
});

describe('sparklineFractions', () => {
  it('maps a series into 0..1 with the largest value at the top', () => {
    const out = sparklineFractions([
      { tsMs: 1, value: 0 },
      { tsMs: 2, value: 50 },
      { tsMs: 3, value: 100 },
    ]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(1);
    expect(out[1]).toBeGreaterThan(out[0]);
  });

  it('draws a flat series mid-plot instead of dividing by zero', () => {
    const out = sparklineFractions([
      { tsMs: 1, value: 7 },
      { tsMs: 2, value: 7 },
    ]);
    expect(out.every((f) => Number.isFinite(f))).toBe(true);
    expect(out[0]).toBeCloseTo(0.5);
  });

  it('refuses to draw a trend through a single observation', () => {
    // A line through one point implies a slope nothing measured.
    expect(sparklineFractions([{ tsMs: 1, value: 5 }])).toEqual([]);
    expect(sparklineFractions([])).toEqual([]);
  });
});

describe('sparklinePolyline', () => {
  it('spans the viewbox and inverts y so a higher value sits higher', () => {
    const points = sparklinePolyline(
      [
        { tsMs: 1, value: 0 },
        { tsMs: 2, value: 100 },
      ],
      100,
      20,
    );
    const [first, last] = points.split(' ');
    expect(first).toBe('0.00,20.00');
    expect(last).toBe('100.00,0.00');
  });

  it('is empty when there is nothing to draw', () => {
    expect(sparklinePolyline([{ tsMs: 1, value: 5 }], 100, 20)).toBe('');
  });
});

describe('labels', () => {
  it('spells the service tokens the way AWS does', () => {
    expect(infraServiceLabel('ec2')).toBe('EC2');
    expect(infraServiceLabel('rds')).toBe('RDS');
    expect(infraServiceLabel('natgw')).toBe('NATGW');
  });

  it('falls back to the resource id when AWS gave the resource no name', () => {
    const base = {
      resourceKey: 'k',
      service: 'ec2',
      resourceId: 'i-0abc',
      region: 'us-east-1',
      accountId: '1',
      environment: null,
      state: null,
      lastSeen: 0,
      metricDimensions: null,
      features: null,
      metrics: [],
    } satisfies Omit<InfraFleetResourceWire, 'name'>;

    expect(fleetResourceTitle({ ...base, name: null })).toBe('i-0abc');
    expect(fleetResourceTitle({ ...base, name: '  ' })).toBe('i-0abc');
    // A name that only repeats the id is noise, not a title.
    expect(fleetResourceTitle({ ...base, name: 'i-0abc' })).toBe('i-0abc');
    expect(fleetResourceTitle({ ...base, name: 'web-1' })).toBe('web-1');
  });
});
