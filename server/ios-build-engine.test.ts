/**
 * Tests for iOS build engine constants and utility exports.
 */
import { describe, it, expect } from 'vitest';
import {
  MAX_CONCURRENT_IOS_BUILDS,
  DEFAULT_XCODE_VERSION,
  BUILD_TIMEOUT_MINUTES,
} from './ios-build-engine.js';

describe('ios-build-engine constants', () => {
  it('exports MAX_CONCURRENT_IOS_BUILDS as a positive number', () => {
    expect(typeof MAX_CONCURRENT_IOS_BUILDS).toBe('number');
    expect(MAX_CONCURRENT_IOS_BUILDS).toBeGreaterThan(0);
  });

  it('exports DEFAULT_XCODE_VERSION as a semver-like string', () => {
    expect(typeof DEFAULT_XCODE_VERSION).toBe('string');
    expect(DEFAULT_XCODE_VERSION).toMatch(/^\d+\.\d+/);
  });

  it('exports BUILD_TIMEOUT_MINUTES as a positive number', () => {
    expect(typeof BUILD_TIMEOUT_MINUTES).toBe('number');
    expect(BUILD_TIMEOUT_MINUTES).toBeGreaterThan(0);
  });

  it('limits concurrent builds to a conservative value (VM cost)', () => {
    // EC2 Mac instances are expensive — limit should be small
    expect(MAX_CONCURRENT_IOS_BUILDS).toBeLessThanOrEqual(5);
  });

  it('build timeout is at least 10 minutes', () => {
    // iOS builds are slow — need enough time
    expect(BUILD_TIMEOUT_MINUTES).toBeGreaterThanOrEqual(10);
  });
});
