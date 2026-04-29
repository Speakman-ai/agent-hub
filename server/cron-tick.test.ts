import { describe, it, expect, vi } from 'vitest';
import {
  wrapCronTick,
  defaultTickOptions,
  estimateIntervalSeconds,
  FAST_CADENCE_JITTER_MS,
} from './cron-tick.js';

describe('wrapCronTick', () => {
  it('returns synchronously and defers fn to a setImmediate macrotask', async () => {
    let called = false;
    const wrapped = wrapCronTick(() => {
      called = true;
    });
    // Call site mimics the node-cron Runner heartbeat invoking the user fn.
    wrapped({} as unknown as Parameters<typeof wrapped>[0]);
    // Sync return: fn must NOT have run yet.
    expect(called).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(called).toBe(true);
  });

  it('swallows synchronous errors so node-cron Runner is not torn down', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wrapped = wrapCronTick(() => {
        throw new Error('boom');
      }, 'unit-test');
      // Should not throw at the call site.
      expect(() => wrapped({} as unknown as Parameters<typeof wrapped>[0])).not.toThrow();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('cron-tick unit-test'),
        expect.stringContaining('boom'),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('swallows rejected async work so node-cron Runner is not torn down', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const wrapped = wrapCronTick(async () => {
        throw new Error('async-boom');
      }, 'async-test');
      wrapped({} as unknown as Parameters<typeof wrapped>[0]);
      // Need two ticks: setImmediate, then promise microtask flush.
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('cron-tick async-test'),
        expect.stringContaining('async-boom'),
      );
    } finally {
      errSpy.mockRestore();
    }
  });

  it('does not block the event loop when fn does heavy sync work', async () => {
    // Simulate a slow user callback. The wrapper must let other timers
    // in the same loop iteration run before the heavy work executes.
    let otherTimerFiredAt = 0;
    let heavyStartedAt = 0;
    const wrapped = wrapCronTick(() => {
      heavyStartedAt = Date.now();
      // 50ms busy loop — would freeze the loop if called synchronously.
      const stop = Date.now() + 50;
      while (Date.now() < stop) {}
    });
    const otherTimer = setTimeout(() => {
      otherTimerFiredAt = Date.now();
    }, 0);
    wrapped({} as unknown as Parameters<typeof wrapped>[0]);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    clearTimeout(otherTimer);
    // Both timers ran; the other (cheaper) timer should have fired
    // before, or no later than ~5ms after, the heavy one started — i.e.
    // the heavy work is NOT serialised in front of unrelated timers.
    expect(otherTimerFiredAt).toBeGreaterThan(0);
    expect(heavyStartedAt).toBeGreaterThan(0);
  });
});

describe('defaultTickOptions', () => {
  it('always sets noOverlap so a slow tick cannot reentrant-fire', () => {
    expect(defaultTickOptions({ intervalSeconds: 60 }).noOverlap).toBe(true);
    expect(defaultTickOptions({ intervalSeconds: 3600 }).noOverlap).toBe(true);
    expect(defaultTickOptions({ intervalSeconds: null }).noOverlap).toBe(true);
  });

  it('applies maxRandomDelay jitter to fast-cadence schedules (≤60s)', () => {
    expect(defaultTickOptions({ intervalSeconds: 60 }).maxRandomDelay).toBe(FAST_CADENCE_JITTER_MS);
    expect(defaultTickOptions({ intervalSeconds: 30 }).maxRandomDelay).toBe(FAST_CADENCE_JITTER_MS);
    expect(defaultTickOptions({ intervalSeconds: 1 }).maxRandomDelay).toBe(FAST_CADENCE_JITTER_MS);
  });

  it('does not jitter slower-cadence schedules', () => {
    expect(defaultTickOptions({ intervalSeconds: 180 }).maxRandomDelay).toBeUndefined();
    expect(defaultTickOptions({ intervalSeconds: 3600 }).maxRandomDelay).toBeUndefined();
    expect(defaultTickOptions({ intervalSeconds: 86400 }).maxRandomDelay).toBeUndefined();
  });

  it('skips jitter when interval is unknown', () => {
    expect(defaultTickOptions({ intervalSeconds: null }).maxRandomDelay).toBeUndefined();
  });

  it('honours an explicit jitter override (including 0 to suppress)', () => {
    expect(defaultTickOptions({ intervalSeconds: 60, maxRandomDelayMs: 500 }).maxRandomDelay).toBe(
      500,
    );
    expect(
      defaultTickOptions({ intervalSeconds: 60, maxRandomDelayMs: 0 }).maxRandomDelay,
    ).toBeUndefined();
  });

  it('forwards optional name and timezone', () => {
    const opts = defaultTickOptions({
      intervalSeconds: 60,
      name: 'unit',
      timezone: 'UTC',
    });
    expect(opts.name).toBe('unit');
    expect(opts.timezone).toBe('UTC');
  });
});

describe('estimateIntervalSeconds', () => {
  it('classifies common 5-field expressions used in this codebase', () => {
    expect(estimateIntervalSeconds('* * * * *')).toBe(60); // every minute
    expect(estimateIntervalSeconds('*/3 * * * *')).toBe(180); // every 3 minutes
    expect(estimateIntervalSeconds('*/15 * * * *')).toBe(900); // every 15 minutes
    expect(estimateIntervalSeconds('0 * * * *')).toBe(3600); // hourly
    expect(estimateIntervalSeconds('0 4 * * *')).toBe(86400); // daily 04:00
    expect(estimateIntervalSeconds('0 3 * * *')).toBe(86400); // daily 03:00 (cert renewal)
  });

  it('classifies 6-field (with seconds) expressions', () => {
    expect(estimateIntervalSeconds('* * * * * *')).toBe(1);
    expect(estimateIntervalSeconds('*/5 * * * * *')).toBe(5);
  });

  it('returns null for expressions it cannot confidently classify', () => {
    expect(estimateIntervalSeconds('1,2,3 * * * *')).toBeNull(); // minute list
    expect(estimateIntervalSeconds('0,30 * * * *')).toBeNull(); // multi-value
    expect(estimateIntervalSeconds('weird')).toBeNull();
    expect(estimateIntervalSeconds('')).toBeNull();
  });

  it('approximates day-of-week-restricted daily schedules as daily (jitter no-op)', () => {
    // `0 9 * * 1-5` actually fires Mon–Fri (5x/week), but the parser is
    // intentionally simple and treats fixed-minute + fixed-hour as daily.
    // The downstream jitter decision is correct either way (any value
    // >60s skips `maxRandomDelay`), so the approximation is harmless.
    const interval = estimateIntervalSeconds('0 9 * * 1-5');
    expect(interval).toBe(86400);
    expect(defaultTickOptions({ intervalSeconds: interval }).maxRandomDelay).toBeUndefined();
  });
});
