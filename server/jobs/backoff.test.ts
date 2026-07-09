import { describe, expect, it } from 'vitest';
import { backoffDelayMs } from './backoff.js';

describe('backoffDelayMs', () => {
  it('grows exponentially from baseMs by factor', () => {
    const opts = { baseMs: 1000, factor: 2, maxMs: 1_000_000 };
    expect(backoffDelayMs(1, opts)).toBe(1000); // base * 2^0
    expect(backoffDelayMs(2, opts)).toBe(2000); // base * 2^1
    expect(backoffDelayMs(3, opts)).toBe(4000);
    expect(backoffDelayMs(4, opts)).toBe(8000);
  });

  it('clamps to maxMs', () => {
    const opts = { baseMs: 1000, factor: 2, maxMs: 5000 };
    expect(backoffDelayMs(3, opts)).toBe(4000);
    expect(backoffDelayMs(4, opts)).toBe(5000); // would be 8000, clamped
    expect(backoffDelayMs(50, opts)).toBe(5000); // huge exponent stays capped
  });

  it('treats attempt < 1 as the first retry', () => {
    const opts = { baseMs: 250, factor: 3 };
    expect(backoffDelayMs(0, opts)).toBe(250);
    expect(backoffDelayMs(-5, opts)).toBe(250);
  });

  it('applies full jitter with an injected rng', () => {
    const opts = { baseMs: 1000, factor: 2, maxMs: 100_000, jitter: true, rng: () => 0.5 };
    expect(backoffDelayMs(3, opts)).toBe(2000); // 4000 * 0.5
    const zero = backoffDelayMs(3, { ...opts, rng: () => 0 });
    expect(zero).toBe(0);
  });

  it('uses sensible defaults when no options given', () => {
    expect(backoffDelayMs(1)).toBe(1000);
    expect(backoffDelayMs(2)).toBe(2000);
    expect(backoffDelayMs(100)).toBe(5 * 60 * 1000); // default cap
  });
});
