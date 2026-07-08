import { describe, it, expect } from 'vitest';
import {
  FrustrationDetector,
  RAGE_CLICK_THRESHOLD,
  RAGE_CLICK_WINDOW_MS,
  DEAD_CLICK_WINDOW_MS,
  ERROR_CLICK_WINDOW_MS,
  MAX_TRACKED_TARGETS,
  FRUSTRATION_RAGE,
  FRUSTRATION_DEAD,
  FRUSTRATION_ERROR,
  isClickEvent,
  isDomMutationEvent,
  clickTargetId,
} from './frustration';

/** rrweb-shaped click event on a given target node id. */
function clickEvent(id: number, timestamp: number) {
  return { type: 3, timestamp, data: { source: 2, type: 2, id, x: 0, y: 0 } };
}
/** rrweb-shaped DOM-mutation event. */
function mutationEvent(timestamp: number) {
  return {
    type: 3,
    timestamp,
    data: { source: 0, adds: [], removes: [], texts: [], attributes: [] },
  };
}

describe('rrweb event classifiers', () => {
  it('recognizes a click event and its target id', () => {
    const ev = clickEvent(42, 1000);
    expect(isClickEvent(ev)).toBe(true);
    expect(isDomMutationEvent(ev)).toBe(false);
    expect(clickTargetId(ev)).toBe('42');
  });

  it('recognizes a mutation event', () => {
    const ev = mutationEvent(1000);
    expect(isDomMutationEvent(ev)).toBe(true);
    expect(isClickEvent(ev)).toBe(false);
  });

  it('does not classify a non-click mouse interaction as a click', () => {
    // MouseInteractions.MouseDown === 1, not Click (2).
    const ev = { type: 3, timestamp: 1, data: { source: 2, type: 1, id: 5 } };
    expect(isClickEvent(ev)).toBe(false);
  });

  it('is null-safe', () => {
    expect(isClickEvent(null)).toBe(false);
    expect(isDomMutationEvent(undefined)).toBe(false);
    expect(clickTargetId({ data: {} })).toBe('');
  });
});

describe('rage click threshold', () => {
  it('does NOT fire at exactly the threshold count within the window', () => {
    const d = new FrustrationDetector();
    // RAGE_CLICK_THRESHOLD clicks on the same element inside 1s — at threshold,
    // not over it, so no rage yet ("> threshold" per the spec).
    for (let i = 0; i < RAGE_CLICK_THRESHOLD; i++) {
      d.recordClick('el', 1000 + i * 10);
    }
    const drain = d.collect(1000 + RAGE_CLICK_WINDOW_MS + DEAD_CLICK_WINDOW_MS);
    expect(drain.byType.rage).toBe(0);
    expect(drain.actionCount).toBe(RAGE_CLICK_THRESHOLD);
  });

  it('fires once when clicks EXCEED the threshold within the window', () => {
    const d = new FrustrationDetector();
    // One more than the threshold, all within 1s on the same element.
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) {
      d.recordClick('el', 1000 + i * 10);
    }
    const drain = d.collect(5000);
    expect(drain.byType.rage).toBe(1);
    expect(drain.frustrationCount).toBeGreaterThanOrEqual(1);
    expect(drain.actionCount).toBe(RAGE_CLICK_THRESHOLD + 1);
  });

  it('fires only ONCE per burst even as more clicks pile on', () => {
    const d = new FrustrationDetector();
    for (let i = 0; i < RAGE_CLICK_THRESHOLD + 4; i++) {
      d.recordClick('el', 1000 + i * 10);
    }
    expect(d.collect(5000).byType.rage).toBe(1);
  });

  it('does NOT fire when the clicks are spread beyond the window', () => {
    const d = new FrustrationDetector();
    // 4 clicks but each more than 1s apart — window never holds > threshold.
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) {
      d.recordClick('el', i * (RAGE_CLICK_WINDOW_MS + 100));
    }
    expect(d.collect(100000).byType.rage).toBe(0);
  });

  it('does NOT fire when clicks land on DIFFERENT elements', () => {
    const d = new FrustrationDetector();
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) {
      d.recordClick(`el-${i}`, 1000 + i * 10);
    }
    expect(d.collect(5000).byType.rage).toBe(0);
  });

  it('can fire a second burst after the window resets', () => {
    const d = new FrustrationDetector();
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) d.recordClick('el', 1000 + i * 10);
    // Large gap resets the sliding window, then a second burst on the same el.
    const base = 1000 + 10 * RAGE_CLICK_THRESHOLD + RAGE_CLICK_WINDOW_MS * 5;
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) d.recordClick('el', base + i * 10);
    expect(d.collect(base + 100000).byType.rage).toBe(2);
  });
});

describe('dead click threshold', () => {
  it('flags a click with NO DOM mutation within the window', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    // No mutation at all. Mature the click.
    const drain = d.collect(1000 + DEAD_CLICK_WINDOW_MS);
    expect(drain.byType.dead).toBe(1);
    expect(drain.frustrationCount).toBe(1);
  });

  it('does NOT flag a click when a mutation lands inside the window', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.recordMutation(1000 + DEAD_CLICK_WINDOW_MS - 1); // just in time
    const drain = d.collect(1000 + DEAD_CLICK_WINDOW_MS);
    expect(drain.byType.dead).toBe(0);
  });

  it('DOES flag a click when the mutation is too late (past the window)', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.recordMutation(1000 + DEAD_CLICK_WINDOW_MS + 1); // one ms too late
    const drain = d.collect(1000 + DEAD_CLICK_WINDOW_MS + 50);
    expect(drain.byType.dead).toBe(1);
  });

  it('leaves a not-yet-matured click PENDING (no premature dead flag)', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    // Collect before the window elapses: click stays pending, no dead yet.
    const drain = d.collect(1000 + DEAD_CLICK_WINDOW_MS - 1);
    expect(drain.byType.dead).toBe(0);
    expect(d.pendingCount).toBe(1);
  });

  it('force-resolves a pending click as dead on teardown', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    const drain = d.collect(1000, { force: true });
    expect(drain.byType.dead).toBe(1);
    expect(d.pendingCount).toBe(0);
  });
});

describe('error click threshold', () => {
  it('flags a click followed by a JS error within the window', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.recordMutation(1010); // DOM changed, so it is NOT a dead click...
    d.recordError(1000 + ERROR_CLICK_WINDOW_MS - 1); // ...but an error followed
    const drain = d.collect(1000 + ERROR_CLICK_WINDOW_MS + 50);
    expect(drain.byType.error).toBe(1);
    expect(drain.byType.dead).toBe(0);
  });

  it('does NOT flag when the error lands past the window', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.recordMutation(1010);
    d.recordError(1000 + ERROR_CLICK_WINDOW_MS + 1); // too late
    const drain = d.collect(1000 + ERROR_CLICK_WINDOW_MS + 50);
    expect(drain.byType.error).toBe(0);
  });

  it('does NOT flag an error that precedes the click', () => {
    const d = new FrustrationDetector();
    d.recordError(900); // before the click
    d.recordClick('btn', 1000);
    d.recordMutation(1010);
    const drain = d.collect(1000 + ERROR_CLICK_WINDOW_MS + 50);
    expect(drain.byType.error).toBe(0);
  });

  it('counts a click that is BOTH dead and error as two signals', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    // No mutation → dead; plus an error in-window → error. Both apply.
    d.recordError(1000 + ERROR_CLICK_WINDOW_MS - 1);
    const drain = d.collect(1000 + ERROR_CLICK_WINDOW_MS + 50);
    expect(drain.byType.dead).toBe(1);
    expect(drain.byType.error).toBe(1);
    expect(drain.frustrationCount).toBe(2);
  });
});

describe('drain / accounting', () => {
  it('counts each click as one action and resets counts after a drain', () => {
    const d = new FrustrationDetector();
    d.recordClick('a', 1000);
    d.recordClick('b', 1100);
    const first = d.collect(5000);
    expect(first.actionCount).toBe(2);
    // Second drain sees no new clicks.
    expect(d.collect(6000).actionCount).toBe(0);
  });

  it('partitions frustration across segments without double-counting', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000); // dead click, matures later
    // First segment flush before maturity: action counted, no frustration yet.
    const seg1 = d.collect(1000 + DEAD_CLICK_WINDOW_MS - 10);
    expect(seg1.actionCount).toBe(1);
    expect(seg1.frustrationCount).toBe(0);
    // Second segment flush after maturity: the dead click finalizes here, once.
    const seg2 = d.collect(1000 + DEAD_CLICK_WINDOW_MS + 10);
    expect(seg2.actionCount).toBe(0);
    expect(seg2.byType.dead).toBe(1);
    // No residue.
    expect(d.collect(999999).frustrationCount).toBe(0);
  });

  it('recordEvent dispatches rrweb clicks and mutations', () => {
    const d = new FrustrationDetector();
    d.recordEvent(clickEvent(7, 1000));
    d.recordEvent(mutationEvent(1010)); // cancels the dead-click
    const drain = d.collect(1000 + DEAD_CLICK_WINDOW_MS + 10);
    expect(drain.actionCount).toBe(1);
    expect(drain.byType.dead).toBe(0);
  });

  it('exposes finalized signals for per-action stamping', () => {
    const d = new FrustrationDetector();
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) d.recordClick('el', 1000 + i * 10);
    const signals = d.drainSignals();
    expect(signals.some((s) => s.type === FRUSTRATION_RAGE)).toBe(true);
  });

  it('reset clears pending clicks and counts', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.reset();
    expect(d.pendingCount).toBe(0);
    expect(d.collect(999999).actionCount).toBe(0);
  });

  it('marks the dead and error type strings as expected', () => {
    expect(FRUSTRATION_DEAD).toBe('dead_click');
    expect(FRUSTRATION_ERROR).toBe('error_click');
    expect(FRUSTRATION_RAGE).toBe('rage_click');
  });
});

describe('two-phase drain (matureAndPeek + commitDrain)', () => {
  it('matureAndPeek returns counts WITHOUT resetting; repeated peeks are stable', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000); // dead click
    const at = 1000 + DEAD_CLICK_WINDOW_MS + 10;
    const first = d.matureAndPeek(at);
    expect(first).toEqual({
      actionCount: 1,
      frustrationCount: 1,
      byType: { rage: 0, dead: 1, error: 0 },
    });
    // Peeking again (e.g. a retried flush) returns the SAME counts — the dead
    // click is not re-counted and the accumulators were not reset.
    expect(d.matureAndPeek(at)).toEqual(first);
  });

  it('commitDrain(snapshot) subtracts only the peeked amounts', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    const at = 1000 + DEAD_CLICK_WINDOW_MS + 10;
    const snap = d.matureAndPeek(at);
    d.commitDrain(snap);
    // After committing exactly the peeked snapshot, the accumulators are clear.
    expect(d.matureAndPeek(at)).toEqual({
      actionCount: 0,
      frustrationCount: 0,
      byType: { rage: 0, dead: 0, error: 0 },
    });
  });

  it('commitDrain() with no snapshot zeroes everything (legacy one-shot)', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000);
    d.matureAndPeek(1000 + DEAD_CLICK_WINDOW_MS + 10);
    d.commitDrain();
    expect(d.matureAndPeek(9_999_999).frustrationCount).toBe(0);
  });

  it('preserves post-peek increments during an in-flight submit (race fix)', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000); // dead click, matures below
    const at = 1000 + DEAD_CLICK_WINDOW_MS + 10;
    // 1) Flush peeks the snapshot for the segment meta...
    const drain = d.matureAndPeek(at);
    expect(drain).toEqual({
      actionCount: 1,
      frustrationCount: 1,
      byType: { rage: 0, dead: 1, error: 0 },
    });
    // 2) ...then, WHILE the submit is in flight, more events arrive on the emit
    //    callback: a fresh click, and a rage burst on another element.
    d.recordClick('btn', at + 5); // +1 action (a new dead click pending)
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) d.recordClick('hot', at + 10 + i); // +rage burst
    // 3) Submit resolves OK → commit ONLY the peeked snapshot.
    d.commitDrain(drain);
    // The post-peek action + rage burst survive for the NEXT segment; the
    // already-sent dead click is gone. (Legacy zeroing would have wiped these.)
    const next = d.matureAndPeek(at + 10_000);
    expect(next.actionCount).toBe(1 + (RAGE_CLICK_THRESHOLD + 1)); // 1 new + burst clicks
    expect(next.byType.rage).toBe(1); // the in-flight burst
    expect(next.byType.dead).toBeGreaterThanOrEqual(1); // the post-peek clicks matured
  });

  it('models a failed-then-retried segment: peek, no commit, peek again re-sends', () => {
    const d = new FrustrationDetector();
    d.recordClick('btn', 1000); // dead click matures below
    const at = 1000 + DEAD_CLICK_WINDOW_MS + 10;
    // Flush attempt #1 builds meta from a peek, then the submit FAILS → no commit.
    const attempt1 = d.matureAndPeek(at);
    expect(attempt1.frustrationCount).toBe(1);
    // Flush attempt #2 (retry) peeks again → same counts still available.
    const attempt2 = d.matureAndPeek(at);
    expect(attempt2.frustrationCount).toBe(1);
    // Submit succeeds → commit exactly that snapshot. Now they are gone.
    d.commitDrain(attempt2);
    expect(d.matureAndPeek(at).frustrationCount).toBe(0);
  });
});

describe('bounded target tracking (rage maps)', () => {
  it('sweeps aged target entries once past the soft cap so the maps stay bounded', () => {
    const d = new FrustrationDetector();
    // Click many DISTINCT elements, each well over a rage-window apart so every
    // prior entry ages out. Without the sweep the map would hold one entry per
    // click; with it, aged entries are evicted once the cap is exceeded.
    const total = MAX_TRACKED_TARGETS + 50;
    for (let i = 0; i < total; i++) {
      d.recordClick(`el-${i}`, i * (RAGE_CLICK_WINDOW_MS + 100));
    }
    // Bounded: the sweep keeps the tracked set from growing with total clicks.
    expect(d.trackedTargetCount).toBeLessThanOrEqual(MAX_TRACKED_TARGETS + 1);
  });

  it('does not evict a still-active target mid-burst (rage still fires)', () => {
    const d = new FrustrationDetector();
    // Fill the map with aged unique targets to push past the cap...
    for (let i = 0; i < MAX_TRACKED_TARGETS + 10; i++) {
      d.recordClick(`old-${i}`, i * (RAGE_CLICK_WINDOW_MS + 100));
    }
    const base = (MAX_TRACKED_TARGETS + 10) * (RAGE_CLICK_WINDOW_MS + 100);
    // ...then a real burst on one element in a tight window still detects rage.
    for (let i = 0; i <= RAGE_CLICK_THRESHOLD; i++) d.recordClick('hot', base + i * 10);
    expect(d.collect(base + 100000).byType.rage).toBe(1);
  });
});
