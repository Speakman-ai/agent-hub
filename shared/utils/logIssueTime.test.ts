import { describe, it, expect } from 'vitest';
import { logIssueSeenMs, MAX_DATE_MS } from './logIssueTime.js';

describe('logIssueSeenMs', () => {
  it('converts epoch nanoseconds to epoch milliseconds', () => {
    expect(logIssueSeenMs(1_700_000_500_000_000_000)).toBe(1_700_000_500_000);
  });

  it('keeps the converted value inside the JS Date range', () => {
    // Regression: passing raw nanoseconds to `new Date()` produced an Invalid
    // Date, which made every issue row render "just now".
    const ms = logIssueSeenMs(1_700_000_500_000_000_000)!;
    expect(Number.isNaN(new Date(ms).getTime())).toBe(false);
    expect(new Date(ms).toISOString()).toBe('2023-11-14T22:21:40.000Z');
  });

  it('preserves age so a 30-minute-old issue is not "just now"', () => {
    const nowMs = 1_700_000_500_000;
    const thirtyMinutesAgoNano = (nowMs - 30 * 60_000) * 1e6;
    expect(nowMs - logIssueSeenMs(thirtyMinutesAgoNano)!).toBe(30 * 60_000);
  });

  it('floors sub-millisecond precision rather than rounding up', () => {
    expect(logIssueSeenMs(1_999_999)).toBe(1);
  });

  it('rejects positive values that underflow to zero milliseconds', () => {
    // Regression: validating the *input* as positive let 1..999_999 ns through
    // to a floored `0`, which callers rendered as a real-looking 1970-01-01.
    expect(logIssueSeenMs(1)).toBeNull();
    expect(logIssueSeenMs(500_000)).toBeNull();
    expect(logIssueSeenMs(999_999)).toBeNull();
    // The first value that survives is exactly one millisecond past the epoch.
    expect(logIssueSeenMs(1_000_000)).toBe(1);
  });

  it('rejects finite values that overflow the representable Date range', () => {
    // Regression: a finite but oversized nanosecond value converted to an
    // out-of-range millisecond value, which formatted as the literal string
    // "Invalid Date" on mobile and a bare "last " label on web.
    expect(logIssueSeenMs(1e22)).toBeNull();
    expect(logIssueSeenMs(Number.MAX_VALUE)).toBeNull();
    expect(logIssueSeenMs((MAX_DATE_MS + 1) * 1e6)).toBeNull();
    // The last value that survives is exactly the Date maximum.
    expect(logIssueSeenMs(MAX_DATE_MS * 1e6)).toBe(MAX_DATE_MS);
  });

  it('pins MAX_DATE_MS to the platform Date boundary', () => {
    expect(Number.isNaN(new Date(MAX_DATE_MS).getTime())).toBe(false);
    expect(Number.isNaN(new Date(MAX_DATE_MS + 1).getTime())).toBe(true);
  });

  it('returns null for absent, non-numeric, non-finite, or non-positive input', () => {
    expect(logIssueSeenMs(null)).toBeNull();
    expect(logIssueSeenMs(undefined)).toBeNull();
    expect(logIssueSeenMs(NaN)).toBeNull();
    expect(logIssueSeenMs(Infinity)).toBeNull();
    expect(logIssueSeenMs(0)).toBeNull();
    expect(logIssueSeenMs(-1)).toBeNull();
    expect(logIssueSeenMs(-1_500_000)).toBeNull();
    expect(logIssueSeenMs('1700000000000000000' as unknown as number)).toBeNull();
  });

  it('never returns a value that formats to a broken or fabricated date', () => {
    // The load-bearing invariant: callers render a non-null result directly, so
    // anything that would surface as 1970, "Invalid Date", or an empty string
    // must come back null. Each of the three defects fixed on this branch was a
    // different input class violating exactly this, so assert it wholesale.
    const inputs = [
      0,
      1,
      -1,
      999_999,
      1_000_000,
      -1_500_000,
      1e15,
      1.7e18,
      1e22,
      MAX_DATE_MS * 1e6,
      (MAX_DATE_MS + 1) * 1e6,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      Number.MAX_SAFE_INTEGER,
      NaN,
      Infinity,
      -Infinity,
      null,
      undefined,
    ];

    for (const input of inputs) {
      const ms = logIssueSeenMs(input as number);
      if (ms === null) continue;
      // Accepted values must be strictly past the epoch instant and inside the
      // representable range, so every formatter produces real output.
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(MAX_DATE_MS);
      expect(Number.isNaN(new Date(ms).getTime())).toBe(false);
      expect(new Date(ms).toLocaleString()).not.toContain('Invalid');
      expect(new Date(ms).toISOString()).toBeTruthy();
    }
  });
});
