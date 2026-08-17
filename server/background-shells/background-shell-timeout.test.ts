import { describe, it, expect } from 'vitest';
import {
  BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
  BACKGROUND_SHELL_MAX_TIMEOUT_MS,
  clampBackgroundShellTimeoutMs,
  formatBackgroundShellTimeoutCap,
} from './background-shell-timeout.js';

describe('clampBackgroundShellTimeoutMs', () => {
  it('defaults when the request is missing or not a positive number', () => {
    expect(clampBackgroundShellTimeoutMs(undefined)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(null)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs('1800000')).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(0)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(-5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(Number.NaN)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
  });

  it('keeps a shorter-than-default request', () => {
    expect(clampBackgroundShellTimeoutMs(5_000)).toBe(5_000);
    expect(clampBackgroundShellTimeoutMs(1)).toBe(1);
  });

  it('defaults a fractional request instead of flooring it to a near-instant cap', () => {
    // Regression: 1.5 used to floor to 1 ms and kill the shell immediately.
    expect(clampBackgroundShellTimeoutMs(1.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(5_000.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(0.5)).toBe(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS);
    expect(clampBackgroundShellTimeoutMs(Number.POSITIVE_INFINITY)).toBe(
      BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS,
    );
  });

  it('clamps anything above the max down to 30 minutes', () => {
    expect(BACKGROUND_SHELL_MAX_TIMEOUT_MS).toBe(30 * 60 * 1000);
    expect(clampBackgroundShellTimeoutMs(BACKGROUND_SHELL_MAX_TIMEOUT_MS + 1)).toBe(
      BACKGROUND_SHELL_MAX_TIMEOUT_MS,
    );
    expect(clampBackgroundShellTimeoutMs(24 * 60 * 60 * 1000)).toBe(
      BACKGROUND_SHELL_MAX_TIMEOUT_MS,
    );
  });
});

describe('formatBackgroundShellTimeoutCap', () => {
  it('renders the default cap as 30-minute', () => {
    expect(formatBackgroundShellTimeoutCap(BACKGROUND_SHELL_DEFAULT_TIMEOUT_MS)).toBe('30-minute');
  });

  it('renders sub-minute caps in seconds', () => {
    expect(formatBackgroundShellTimeoutCap(1_000)).toBe('1-second');
    expect(formatBackgroundShellTimeoutCap(5_000)).toBe('5-second');
  });
});
