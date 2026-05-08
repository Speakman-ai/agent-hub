import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_BLOCKED_AD_TRACKER_HOST_SUFFIXES,
  getBrowserMaxConcurrentContexts,
  isBlockedAdTrackerHostname,
  resetBrowserSecurityTestOverrides,
  __setBrowserConcurrencyForTests,
} from './browser-host-policy.js';

describe('browser-host-policy', () => {
  beforeEach(() => {
    resetBrowserSecurityTestOverrides();
  });

  it('tracks subdomains of suffix entries', () => {
    expect(isBlockedAdTrackerHostname('pagead2.googlesyndication.com')).toBe(true);
    expect(isBlockedAdTrackerHostname('stats.g.doubleclick.net')).toBe(true);
  });

  it('does not block unrelated hosts', () => {
    expect(isBlockedAdTrackerHostname('example.com')).toBe(false);
    expect(isBlockedAdTrackerHostname('api.github.com')).toBe(false);
  });

  it('handles apex matches equal to suffix entries', () => {
    expect(isBlockedAdTrackerHostname('google-analytics.com')).toBe(true);
  });

  it('exposes a non-empty curated block suffix list', () => {
    expect(DEFAULT_BLOCKED_AD_TRACKER_HOST_SUFFIXES.length).toBeGreaterThanOrEqual(5);
  });

  it('clamps concurrent-context test override into a safe range', () => {
    __setBrowserConcurrencyForTests(99);
    expect(getBrowserMaxConcurrentContexts()).toBe(48);
    __setBrowserConcurrencyForTests(-5);
    expect(getBrowserMaxConcurrentContexts()).toBe(1);
    __setBrowserConcurrencyForTests(7);
    expect(getBrowserMaxConcurrentContexts()).toBe(7);
    resetBrowserSecurityTestOverrides();
    expect(getBrowserMaxConcurrentContexts()).toBeGreaterThanOrEqual(1);
    expect(getBrowserMaxConcurrentContexts()).toBeLessThanOrEqual(48);
  });
});
