import { describe, expect, it } from 'vitest';
import {
  normalizeOAuthExpiresAtMs,
  OAUTH_EXPIRES_AT_MS_THRESHOLD,
  parseClaudeOAuthExpiry,
} from './oauth-expiry.js';

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

describe('parseClaudeOAuthExpiry', () => {
  it('returns null for nullish / empty input', () => {
    expect(parseClaudeOAuthExpiry(null)).toBeNull();
    expect(parseClaudeOAuthExpiry(undefined)).toBeNull();
    expect(parseClaudeOAuthExpiry('')).toBeNull();
    expect(parseClaudeOAuthExpiry('   ')).toBeNull();
  });

  it('returns null for unparseable garbage', () => {
    expect(parseClaudeOAuthExpiry('not-a-date')).toBeNull();
    expect(parseClaudeOAuthExpiry('NaN')).toBeNull();
  });

  it('treats a future numeric string in Unix seconds as not expired', () => {
    const futureSec = Math.floor(Date.now() / 1000) + 3600;
    const r = parseClaudeOAuthExpiry(String(futureSec));
    expect(r).not.toBeNull();
    expect(r!.expiresAtMs).toBe(futureSec * 1000);
    expect(r!.expired).toBe(false);
    // ISO round-trip should also be future-dated.
    expect(Date.parse(r!.iso)).toBe(futureSec * 1000);
  });

  it('treats a future numeric string in epoch ms as not expired', () => {
    const futureMs = Date.now() + 3_600_000;
    const r = parseClaudeOAuthExpiry(String(futureMs));
    expect(r).not.toBeNull();
    expect(r!.expiresAtMs).toBe(futureMs);
    expect(r!.expired).toBe(false);
  });

  it('treats a past numeric string in Unix seconds as expired', () => {
    const pastSec = Math.floor(Date.now() / 1000) - 3600;
    const r = parseClaudeOAuthExpiry(String(pastSec));
    expect(r).not.toBeNull();
    expect(r!.expired).toBe(true);
  });

  it('parses ISO 8601 strings without rescaling', () => {
    const futureMs = Date.now() + 86_400_000;
    const iso = new Date(futureMs).toISOString();
    const r = parseClaudeOAuthExpiry(iso);
    expect(r).not.toBeNull();
    expect(r!.expiresAtMs).toBe(futureMs);
    expect(r!.expired).toBe(false);
  });

  it('accepts a raw number (Unix seconds)', () => {
    const futureSec = Math.floor(Date.now() / 1000) + 7200;
    const r = parseClaudeOAuthExpiry(futureSec);
    expect(r).not.toBeNull();
    expect(r!.expiresAtMs).toBe(futureSec * 1000);
    expect(r!.expired).toBe(false);
  });

  it('accepts a raw number (epoch ms)', () => {
    const futureMs = Date.now() + 7_200_000;
    const r = parseClaudeOAuthExpiry(futureMs);
    expect(r).not.toBeNull();
    expect(r!.expiresAtMs).toBe(futureMs);
    expect(r!.expired).toBe(false);
  });

  it('rejects NaN/Infinity numeric input', () => {
    expect(parseClaudeOAuthExpiry(Number.NaN)).toBeNull();
    // Infinity normalises to itself; treat as null because no real expiry
    // is meaningfully infinite and we don't want the UI to render
    // "Expires in Infinity".
    expect(parseClaudeOAuthExpiry(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
