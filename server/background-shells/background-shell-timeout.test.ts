import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
  normalizeBackgroundShellTimeoutMs,
  formatBackgroundShellTimeoutCap,
} from './background-shell-timeout.js';

describe('normalizeBackgroundShellTimeoutMs', () => {
  it('defaults when the request is missing or not a positive number', () => {
    expect(normalizeBackgroundShellTimeoutMs(undefined)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(null)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs('1800000')).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(0)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(-5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(Number.NaN)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
  });

  it('keeps a shorter-than-default request', () => {
    expect(normalizeBackgroundShellTimeoutMs(5_000)).toBe(5_000);
    expect(normalizeBackgroundShellTimeoutMs(1)).toBe(1);
  });

  it('defaults a fractional request instead of flooring it to a near-instant cap', () => {
    // Regression: 1.5 used to floor to 1 ms and kill the shell immediately.
    expect(normalizeBackgroundShellTimeoutMs(1.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(5_000.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(0.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(normalizeBackgroundShellTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
    );
  });

  it('honors a requested deadline longer than 30 minutes', () => {
    expect(normalizeBackgroundShellTimeoutMs(24 * 60 * 60 * 1000)).toBe(86_400_000);
    expect(normalizeBackgroundShellTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(normalizeBackgroundShellTimeoutMs(Number.MAX_SAFE_INTEGER + 1)).toBe(0);
  });
});

describe('formatBackgroundShellTimeoutCap', () => {
  it('renders a requested 30-minute deadline', () => {
    expect(formatBackgroundShellTimeoutCap(1_800_000)).toBe('30-minute');
  });

  it('renders sub-minute caps in seconds', () => {
    expect(formatBackgroundShellTimeoutCap(1_000)).toBe('1-second');
    expect(formatBackgroundShellTimeoutCap(5_000)).toBe('5-second');
  });
});
