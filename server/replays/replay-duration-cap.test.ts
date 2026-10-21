import { describe, it, expect } from 'vitest';
import {
  REPLAY_MAX_DURATION_MS,
  capCapture,
  splitAtDurationCap,
  trimToRecentCheckout,
} from './replay-duration-cap.js';
import type { ReplayEvent } from './replay-store.js';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const meta = (t: number): ReplayEvent => ({ type: 4, timestamp: t });
const snap = (t: number): ReplayEvent => ({ type: 2, timestamp: t });
const inc = (t: number): ReplayEvent => ({ type: 3, timestamp: t });

describe('REPLAY_MAX_DURATION_MS', () => {
  it('defaults to 15 minutes', () => {
    expect(REPLAY_MAX_DURATION_MS).toBe(15 * MIN);
  });
});

describe('trimToRecentCheckout', () => {
  it('starts an on-error buffer at the earliest checkout inside the cap', () => {
    // Shape of a real 122h on-error capture: a checkout at page load, days of
    // idle, then a fresh checkout just before the report.
    const events = [
      meta(0),
      snap(1),
      inc(10),
      meta(122 * HOUR),
      snap(122 * HOUR + 1),
      inc(122 * HOUR + 40 * 1000),
    ];
    const out = trimToRecentCheckout(events, 15 * MIN);
    expect(out.map((e) => e.type)).toEqual([4, 2, 3]);
    expect(out[0].timestamp).toBe(122 * HOUR);
  });

  it('keeps the earliest in-window checkout, not the latest', () => {
    const events = [
      meta(0),
      snap(1),
      meta(HOUR),
      snap(HOUR + 1),
      inc(HOUR + 2 * MIN),
      snap(HOUR + 5 * MIN),
      inc(HOUR + 6 * MIN),
    ];
    const out = trimToRecentCheckout(events, 15 * MIN);
    expect(out[0].timestamp).toBe(HOUR);
    expect(out).toHaveLength(5);
  });

  it('falls back to the latest checkout when none is inside the cap', () => {
    const events = [snap(0), inc(1), snap(HOUR), inc(10 * HOUR)];
    expect(trimToRecentCheckout(events, 15 * MIN).map((e) => e.timestamp)).toEqual([
      HOUR,
      10 * HOUR,
    ]);
  });

  it('returns the events unchanged when already within the cap or without a checkout', () => {
    const short = [meta(0), snap(1), inc(5 * MIN)];
    expect(trimToRecentCheckout(short, 15 * MIN)).toBe(short);
    const noSnap = [inc(0), inc(HOUR)];
    expect(trimToRecentCheckout(noSnap, 15 * MIN)).toBe(noSnap);
  });
});

describe('splitAtDurationCap', () => {
  it('accepts a batch that stays inside the bound', () => {
    const batch = [inc(MIN), inc(14 * MIN)];
    expect(splitAtDurationCap(0, batch, 15 * MIN)).toEqual({ accepted: batch, overflow: false });
  });

  it('cuts the batch at the first event past the bound (idle-tab gap)', () => {
    const batch = [inc(10 * MIN), inc(12 * MIN), inc(9 * HOUR), inc(9 * HOUR + 1)];
    const { accepted, overflow } = splitAtDurationCap(0, batch, 15 * MIN);
    expect(accepted.map((e) => e.timestamp)).toEqual([10 * MIN, 12 * MIN]);
    expect(overflow).toBe(true);
  });

  it('accepts nothing when the batch starts past the bound', () => {
    expect(splitAtDurationCap(0, [inc(16 * MIN)], 15 * MIN)).toEqual({
      accepted: [],
      overflow: true,
    });
  });
});

describe('capCapture', () => {
  it('cuts the stale tail when the only checkout is old (19h idle tab)', () => {
    const { events, overflow } = capCapture([snap(0), inc(MIN), inc(19 * HOUR)], 15 * MIN);
    expect(events.map((e) => e.timestamp)).toEqual([0, MIN]);
    expect(overflow).toBe(true);
  });

  it('bounds the latest-checkout fallback to the cap', () => {
    const { events } = capCapture([snap(0), inc(1), snap(HOUR), inc(10 * HOUR)], 15 * MIN);
    expect(events.map((e) => e.timestamp)).toEqual([HOUR]);
  });

  it('never stores a span past the cap', () => {
    const { events } = capCapture([meta(0), snap(1), inc(14 * MIN), inc(20 * MIN)], 15 * MIN);
    const span = events[events.length - 1].timestamp - events[0].timestamp;
    expect(span).toBeLessThanOrEqual(15 * MIN);
  });

  it('leaves an in-bound capture untouched', () => {
    const short = [meta(0), snap(1), inc(5 * MIN)];
    expect(capCapture(short, 15 * MIN)).toEqual({ events: short, overflow: false });
  });
});
