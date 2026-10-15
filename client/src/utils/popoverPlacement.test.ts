import { describe, it, expect } from 'vitest';
import { placePopover } from './popoverPlacement';

const opts = { preferredWidth: 360, preferredHeight: 560, margin: 8 };
const bell = (top: number, left = 200) => ({ top, bottom: top + 36, left, right: left + 36 });

function fits(p: ReturnType<typeof placePopover>, vh: number) {
  const top = p.top ?? vh - p.bottom! - p.maxHeight;
  const bottom = p.top != null ? p.top + p.maxHeight : vh - p.bottom!;
  return top >= 8 && bottom <= vh - 8;
}

describe('placePopover', () => {
  it('opens below with the full height when there is room', () => {
    const p = placePopover(bell(10), { width: 1200, height: 900 }, 'below', opts);
    expect(p).toMatchObject({ top: 50, maxHeight: 560 });
    expect(fits(p, 900)).toBe(true);
  });

  it('caps the height to the space below the trigger on a short viewport', () => {
    const p = placePopover(bell(10), { width: 1200, height: 400 }, 'below', opts);
    expect(p.top).toBe(50);
    expect(p.maxHeight).toBe(400 - 8 - 50);
    expect(fits(p, 400)).toBe(true);
  });

  it('flips above when the trigger sits low and there is more room above', () => {
    const p = placePopover(bell(600), { width: 1200, height: 700 }, 'below', opts);
    expect(p.top).toBeUndefined();
    expect(p.bottom).toBe(700 - 596);
    expect(p.maxHeight).toBe(560);
    expect(fits(p, 700)).toBe(true);
  });

  it('slides a rail popover up so it fits beside a low trigger', () => {
    const p = placePopover(bell(500), { width: 1200, height: 600 }, 'right', opts);
    expect(p.left).toBe(240);
    expect(p.top! + p.maxHeight).toBeLessThanOrEqual(592);
    expect(p.maxHeight).toBe(560);
    expect(fits(p, 600)).toBe(true);
  });

  it('never exceeds a viewport smaller than the preferred size', () => {
    for (const placement of ['below', 'right'] as const) {
      for (const top of [8, 100, 200]) {
        const p = placePopover(bell(top), { width: 320, height: 260 }, placement, opts);
        expect(fits(p, 260)).toBe(true);
        expect(p.width).toBe(304);
      }
    }
  });
});
