import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from './recent-pushes.js';

describe('recent-pushes mapWithConcurrency', () => {
  it('limits concurrent git-backed checks', async () => {
    let active = 0;
    let maxActive = 0;

    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active -= 1;
      return value * 2;
    });

    expect(result).toEqual([2, 4, 6, 8, 10, 12]);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
