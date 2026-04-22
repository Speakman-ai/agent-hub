import { describe, it, expect } from 'vitest';
import { isNearBottom, CHAT_STICK_TO_BOTTOM_THRESHOLD_PX } from './chatScroll.js';

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
