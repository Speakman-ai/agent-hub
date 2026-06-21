import { describe, it, expect, vi } from 'vitest';
import {
  isNearBottom,
  CHAT_STICK_TO_BOTTOM_THRESHOLD_PX,
  forcePinChatTailScroll,
  shouldFollowTailAfterScroll,
} from './chatScroll.js';

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
    const pin = vi.fn((target) => {
      target.scrollTop = target.scrollHeight;
    });
    forcePinChatTailScroll(el, pin);
    expect(pin).toHaveBeenCalledWith(el);
    expect(el.scrollTop).toBe(500);
  });

  it('returns a cleanup function', () => {
    const el = { scrollHeight: 500, scrollTop: 0, clientHeight: 100, isConnected: true };
    const cancel = forcePinChatTailScroll(el, vi.fn());
    expect(typeof cancel).toBe('function');
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
});
