import { describe, it, expect } from 'vitest';
import { exceedsBrowserConcurrencyAfterReservation } from './browser.js';

describe('exceedsBrowserConcurrencyAfterReservation', () => {
  it('allows reservations while live + pending slots stay within max', () => {
    expect(exceedsBrowserConcurrencyAfterReservation(0, 1, 2)).toBe(false);
    expect(exceedsBrowserConcurrencyAfterReservation(0, 2, 2)).toBe(false);
    expect(exceedsBrowserConcurrencyAfterReservation(1, 1, 2)).toBe(false);
  });

  it('rejects when a new reservation pushes live + pending over max', () => {
    expect(exceedsBrowserConcurrencyAfterReservation(0, 3, 2)).toBe(true);
    expect(exceedsBrowserConcurrencyAfterReservation(2, 1, 2)).toBe(true);
  });
});
