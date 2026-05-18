import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordHmacFailure,
  getRecentHmacFailures,
  clearHmacFailures,
  shouldAttemptAppSecretHeal,
  resetHealThrottle,
  __testing__,
} from './webhook-hmac-failures.js';

describe('webhook-hmac-failures ring buffer', () => {
  beforeEach(() => {
    clearHmacFailures();
    resetHealThrottle();
  });

  it('records a single failure and returns it', () => {
    recordHmacFailure({
      repoFullName: 'foo/bar',
      eventLabel: 'pull_request.opened',
      deliveryId: 'd1',
      triedSources: 'repo',
      isAppDelivery: false,
    });
    const list = getRecentHmacFailures();
    expect(list).toHaveLength(1);
    expect(list[0].repoFullName).toBe('foo/bar');
    expect(list[0].deliveryId).toBe('d1');
    expect(list[0].healAttempted).toBe(false);
    expect(typeof list[0].ts).toBe('number');
  });

  it('returns failures in newest-first order', () => {
    recordHmacFailure({
      repoFullName: 'r/old',
      eventLabel: 'push',
      deliveryId: 'old',
      triedSources: 'repo',
      isAppDelivery: false,
    });
    recordHmacFailure({
      repoFullName: 'r/new',
      eventLabel: 'push',
      deliveryId: 'new',
      triedSources: 'repo',
      isAppDelivery: false,
    });
    const list = getRecentHmacFailures();
    expect(list.map((f) => f.deliveryId)).toEqual(['new', 'old']);
  });

  it('caps the ring buffer at MAX_FAILURES', () => {
    const cap = __testing__.MAX_FAILURES;
    for (let i = 0; i < cap + 10; i++) {
      recordHmacFailure({
        repoFullName: `r/${i}`,
        eventLabel: 'push',
        deliveryId: `d${i}`,
        triedSources: 'repo',
        isAppDelivery: false,
      });
    }
    const list = getRecentHmacFailures(cap + 50);
    expect(list).toHaveLength(cap);
    // Oldest should be d10 (we dropped d0..d9)
    expect(list[list.length - 1].deliveryId).toBe('d10');
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      recordHmacFailure({
        repoFullName: `r/${i}`,
        eventLabel: 'push',
        deliveryId: `d${i}`,
        triedSources: 'repo',
        isAppDelivery: false,
      });
    }
    expect(getRecentHmacFailures(3)).toHaveLength(3);
    expect(getRecentHmacFailures(100)).toHaveLength(5);
  });
});

describe('shouldAttemptAppSecretHeal throttle', () => {
  beforeEach(() => {
    resetHealThrottle();
  });

  it('returns true on first call', () => {
    expect(shouldAttemptAppSecretHeal()).toBe(true);
  });

  it('refuses a second call within the throttle window', () => {
    expect(shouldAttemptAppSecretHeal(1_000_000)).toBe(true);
    expect(shouldAttemptAppSecretHeal(1_000_000 + 30_000)).toBe(false);
    expect(shouldAttemptAppSecretHeal(1_000_000 + 59_000)).toBe(false);
  });

  it('allows a second call after the throttle window elapses', () => {
    expect(shouldAttemptAppSecretHeal(2_000_000)).toBe(true);
    // throttle is 60s; 60_001ms after should be allowed
    expect(shouldAttemptAppSecretHeal(2_000_000 + __testing__.HEAL_THROTTLE_MS + 1)).toBe(true);
  });

  it('updates the throttle clock only on a true return', () => {
    // first call: true and updates
    expect(shouldAttemptAppSecretHeal(3_000_000)).toBe(true);
    // second call before window: false and does NOT advance clock to "now"
    expect(shouldAttemptAppSecretHeal(3_000_001)).toBe(false);
    // a third call still gated by the original true-call window
    expect(shouldAttemptAppSecretHeal(3_000_002)).toBe(false);
    // only after window since the original true call
    expect(shouldAttemptAppSecretHeal(3_000_000 + __testing__.HEAL_THROTTLE_MS + 1)).toBe(true);
  });
});
