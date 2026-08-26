import { describe, it, expect } from 'vitest';
import { shouldSuppressToast } from './toastPolicy';
import { fetchTimeoutMessage } from './api';

describe('shouldSuppressToast', () => {
  it('suppresses structured request-timeout toasts', () => {
    expect(
      shouldSuppressToast(fetchTimeoutMessage('POST', '/sessions/s1/workspace/ensure', 900_000)),
    ).toBe(true);
    expect(shouldSuppressToast('Request timed out after 15000ms: GET /projects')).toBe(true);
  });

  it('keeps domain timeouts and ordinary errors visible', () => {
    expect(shouldSuppressToast('Preview health check timed out')).toBe(false);
    expect(shouldSuppressToast('Failed to prepare session workspace')).toBe(false);
    expect(shouldSuppressToast('Archive failed: unknown error')).toBe(false);
    expect(shouldSuppressToast(undefined)).toBe(false);
    expect(shouldSuppressToast(null)).toBe(false);
  });
});
