import { describe, it, expect, vi } from 'vitest';
import {
  isNearBottom,
  CHAT_STICK_TO_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  forcePinChatTailScroll,
  shouldFollowTailAfterScroll,
  pinChatToBottom,
} from './chatScroll';

describe('isNearBottom', () => {
  it('returns true when el is null (treat as follow / no container yet)', () => {
    expect(isNearBottom(null)).toBe(true);
  });

  it('returns true when within threshold of the bottom', () => {
    const el = { scrollHeight: 1000, scrollTop: 851, clientHeight: 100 };
    expect(isNearBottom(el, CHAT_STICK_TO_BOTTOM_THRESHOLD_PX)).toBe(true);
  });

  it('returns false when scrolled further up than threshold', () => {
    // gap = scrollHeight - scrollTop - clientHeight = 1000 - 700 - 100 = 200 (> 150)
    const el = { scrollHeight: 1000, scrollTop: 700, clientHeight: 100 };
    expect(isNearBottom(el, CHAT_STICK_TO_BOTTOM_THRESHOLD_PX)).toBe(false);
  });
});

describe('forcePinChatTailScroll', () => {
  it('invokes pin at least once immediately', () => {
    const el = { scrollHeight: 500, scrollTop: 0, clientHeight: 100, isConnected: true };
    const pin = vi.fn((target: any) => {
      target.scrollTop = target.scrollHeight;
    });
    forcePinChatTailScroll(el, pin);
    expect(pin!).toHaveBeenCalledWith(el);
    expect(el!.scrollTop).toBe(500);
  });

  it('returns a cleanup function', () => {
    const el = { scrollHeight: 500, scrollTop: 0, clientHeight: 100, isConnected: true };
    const cancel = forcePinChatTailScroll(el, vi.fn());
    expect(typeof cancel).toBe('function');
  });
});

describe('pinChatToBottom', () => {
  it('snaps to the tail and re-arms follow synchronously, before the next frame', () => {
    // Regression: clicking "Scroll to bottom" while a response streams must
    // re-arm follow immediately. When the flag was set inside requestAnimationFrame,
    // a token arriving in the one-frame gap fired the auto-scroll effect with
    // follow still off, pushing the viewport back below the fold.
    const el = { scrollHeight: 1000, scrollTop: 200, clientHeight: 100 };
    const order: string[] = [];
    let rafCb: (() => void) | null = null;
    pinChatToBottom(el, {
      beginProgrammatic: () => order.push('begin'),
      armFollow: () => order.push('arm'),
      endProgrammatic: () => order.push('end'),
      raf: (cb: () => void) => {
        rafCb = cb;
      },
    });
    // Scroll snapped and follow armed before any rAF has run.
    expect(el.scrollTop).toBe(1000);
    expect(order).toEqual(['begin', 'arm']);
    // The programmatic guard only clears once the deferred frame fires.
    rafCb!();
    expect(order).toEqual(['begin', 'arm', 'end']);
  });

  it('passes the snapped scrollTop to armFollow', () => {
    const el = { scrollHeight: 750, scrollTop: 0, clientHeight: 100 };
    let armedWith = -1;
    pinChatToBottom(el, {
      beginProgrammatic: () => {},
      armFollow: (scrollTop: number) => {
        armedWith = scrollTop;
      },
      endProgrammatic: () => {},
      raf: () => {},
    });
    expect(armedWith).toBe(750);
  });

  it('no-ops on a null element (no container yet)', () => {
    const begin = vi.fn();
    const arm = vi.fn();
    pinChatToBottom(null, {
      beginProgrammatic: begin,
      armFollow: arm,
      endProgrammatic: vi.fn(),
      raf: vi.fn(),
    });
    expect(begin).not.toHaveBeenCalled();
    expect(arm).not.toHaveBeenCalled();
  });
});

describe('shouldFollowTailAfterScroll', () => {
  it('breaks follow on an upward scroll even while still inside the near-bottom band', () => {
    // Regression: a live-growing Finalize "Checks" block re-pinned the viewport
    // to the bottom on every poll because a small scroll-up stayed nearBottom.
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 900, scrollTop: 820, nearBottom: true }),
    ).toBe(false);
  });

  it('keeps following when the user scrolls down toward the tail and is near bottom', () => {
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 700, scrollTop: 880, nearBottom: true }),
    ).toBe(true);
  });

  it('stays unfollowed on an upward scroll away from the bottom', () => {
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 900, scrollTop: 400, nearBottom: false }),
    ).toBe(false);
  });

  it('does not follow when far from the bottom even without moving', () => {
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 400, scrollTop: 400, nearBottom: false }),
    ).toBe(false);
  });

  it('ignores sub-pixel jitter (1px epsilon) and keeps following near the bottom', () => {
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 900.4, scrollTop: 900, nearBottom: true }),
    ).toBe(true);
  });

  it('keeps following when scrollTop dropped because content shrank (browser clamp at the tail)', () => {
    // Regression: at every turn boundary (thinking indicator unmount, streaming
    // tail replaced by the final message) the browser clamped scrollTop down and
    // the resulting scroll event was misread as a user scroll-up, detaching
    // auto-follow. A user scrolling up can never end flush with the bottom.
    expect(
      shouldFollowTailAfterScroll({
        prevScrollTop: 1700,
        scrollTop: 1500,
        nearBottom: true,
        distanceFromBottom: 0,
      }),
    ).toBe(true);
  });

  it('tolerates fractional clamp offsets when deciding the viewport is flush with the tail', () => {
    expect(
      shouldFollowTailAfterScroll({
        prevScrollTop: 1700,
        scrollTop: 1499.5,
        nearBottom: true,
        distanceFromBottom: 0.5,
      }),
    ).toBe(true);
  });

  it('still breaks follow on an upward scroll that leaves a gap below the viewport', () => {
    expect(
      shouldFollowTailAfterScroll({
        prevScrollTop: 1700,
        scrollTop: 1650,
        nearBottom: true,
        distanceFromBottom: 50,
      }),
    ).toBe(false);
  });

  it('breaks follow on an upward scroll when no distance is supplied (legacy callers)', () => {
    expect(
      shouldFollowTailAfterScroll({ prevScrollTop: 1700, scrollTop: 1650, nearBottom: true }),
    ).toBe(false);
  });
});

describe('distanceFromBottom', () => {
  it('returns 0 for a missing container', () => {
    expect(distanceFromBottom(null)).toBe(0);
  });

  it('measures the gap between the viewport bottom edge and the content end', () => {
    expect(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 300 })).toBe(
      200,
    );
    expect(distanceFromBottom({ scrollHeight: 1800, scrollTop: 1500, clientHeight: 300 })).toBe(0);
  });
});
