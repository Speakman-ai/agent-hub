import { describe, expect, it } from 'vitest';
import { normalizeOAuthExpiresAtMs, OAUTH_EXPIRES_AT_MS_THRESHOLD } from './oauth-expiry.js';

describe('normalizeOAuthExpiresAtMs', () => {
  it('multiplies sub-threshold values as Unix seconds → ms', () => {
    const sec = 1_700_000_000;
    expect(normalizeOAuthExpiresAtMs(sec)).toBe(sec * 1000);
  });

  it('leaves ms-scale timestamps unchanged', () => {
    const ms = OAUTH_EXPIRES_AT_MS_THRESHOLD + 99;
    expect(normalizeOAuthExpiresAtMs(ms)).toBe(ms);
  });

  it('treats threshold boundary as already-ms (no multiply)', () => {
    expect(normalizeOAuthExpiresAtMs(OAUTH_EXPIRES_AT_MS_THRESHOLD)).toBe(
      OAUTH_EXPIRES_AT_MS_THRESHOLD,
    );
  });

  it('passes through non-finite numbers', () => {
    expect(normalizeOAuthExpiresAtMs(Number.NaN)).toBeNaN();
    expect(normalizeOAuthExpiresAtMs(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });
});
