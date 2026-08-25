// @ts-nocheck
import { describe, it, expect } from 'vitest';
import { sortFindings, openCriticalHigh, countBySeverity, SEVERITY_RANK } from './securityFindings';
function finding(o: any) {
  return { id: o.id, severity: o.severity, last_seen_at: o.last_seen_at };
}
describe('sortFindings', () => {
  it('orders by severity (critical → unknown) then most-recently-seen first', () => {
    const sorted = sortFindings([
      finding({ id: 'low', severity: 'low', last_seen_at: 5 }),
      finding({ id: 'crit', severity: 'critical', last_seen_at: 1 }),
      finding({ id: 'high', severity: 'high', last_seen_at: 2 }),
      finding({ id: 'med-old', severity: 'medium', last_seen_at: 1 }),
      finding({ id: 'med-new', severity: 'medium', last_seen_at: 9 }),
      finding({ id: 'unk', severity: 'unknown', last_seen_at: 3 }),
    ]);
    expect(sorted.map((f: any) => f.id)).toEqual([
      'crit',
      'high',
      'med-new',
      'med-old',
      'low',
      'unk',
    ]);
  });
  it('does not mutate the input array', () => {
    const input = [finding({ id: 'a', severity: 'low', last_seen_at: 1 })];
    const out = sortFindings(input);
    expect(out).not.toBe(input);
  });
  it('ranks an unknown severity last', () => {
    expect(SEVERITY_RANK.unknown).toBeGreaterThan(SEVERITY_RANK.low);
  });
});
describe('openCriticalHigh', () => {
  it('sums open critical and high counts', () => {
    expect(openCriticalHigh({ critical: 2, high: 3, medium: 9, low: 1 })).toBe(5);
  });
  it('tolerates null / missing fields', () => {
    expect(openCriticalHigh(null)).toBe(0);
    expect(openCriticalHigh({ high: 4 })).toBe(4);
  });
});
describe('countBySeverity', () => {
  it('tallies each severity category plus an all total, bucketing unknowns', () => {
    const counts = countBySeverity([
      finding({ id: 'c', severity: 'critical' }),
      finding({ id: 'h1', severity: 'high' }),
      finding({ id: 'h2', severity: 'high' }),
      finding({ id: 'l', severity: 'low' }),
      finding({ id: 'w', severity: 'weird' }),
      finding({ id: 'u', severity: undefined }),
    ]);
    expect(counts).toEqual({ critical: 1, high: 2, medium: 0, low: 1, unknown: 2, all: 6 });
  });
  it('returns a zeroed map for a non-array', () => {
    expect(countBySeverity(null)).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      all: 0,
    });
  });
});
