import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { cursorOAuthExpiredAt, cursorOAuthExpiredMessage } from './cursor-oauth-expiry.js';

const NOW = Date.parse('2026-10-20T20:00:00Z');

function jwt(expMs: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'none' })}.${enc({ exp: Math.floor(expMs / 1000) })}.sig`;
}

function homeWith(rel: string, body: unknown): string {
  const home = mkdtempSync(path.join(tmpdir(), 'cursor-oauth-expiry-'));
  mkdirSync(path.join(home, path.dirname(rel)), { recursive: true });
  writeFileSync(path.join(home, rel), typeof body === 'string' ? body : JSON.stringify(body));
  return home;
}

const EXPIRED = Date.parse('2026-10-18T02:50:55Z');
const LIVE = Date.parse('2026-12-18T02:50:55Z');

describe('cursorOAuthExpiredAt', () => {
  it('reports the expiry when both tokens are past exp', () => {
    const home = homeWith('.config/cursor/auth.json', {
      accessToken: jwt(EXPIRED),
      refreshToken: jwt(EXPIRED),
    });
    expect(cursorOAuthExpiredAt(home, NOW)).toBe(EXPIRED);
  });

  it('checks the legacy ~/.cursor/auth.json location too', () => {
    const home = homeWith('.cursor/auth.json', {
      accessToken: jwt(EXPIRED),
      refreshToken: jwt(EXPIRED),
    });
    expect(cursorOAuthExpiredAt(home, NOW)).toBe(EXPIRED);
  });

  it('returns null while the refresh token can still renew the login', () => {
    const home = homeWith('.config/cursor/auth.json', {
      accessToken: jwt(EXPIRED),
      refreshToken: jwt(LIVE),
    });
    expect(cursorOAuthExpiredAt(home, NOW)).toBeNull();
  });

  it('returns null when there is no cache or the token shape is unknown', () => {
    expect(cursorOAuthExpiredAt(mkdtempSync(path.join(tmpdir(), 'c-')), NOW)).toBeNull();
    expect(
      cursorOAuthExpiredAt(homeWith('.config/cursor/auth.json', '{"refreshToken":"opaque"}'), NOW),
    ).toBeNull();
    expect(cursorOAuthExpiredAt(homeWith('.config/cursor/auth.json', 'not json'), NOW)).toBeNull();
    expect(cursorOAuthExpiredAt(null, NOW)).toBeNull();
  });

  it('returns null instead of throwing when the cache is valid JSON but not an object', () => {
    for (const body of ['null', '42', '"text"', '[]']) {
      expect(cursorOAuthExpiredAt(homeWith('.config/cursor/auth.json', body), NOW)).toBeNull();
    }
  });

  it('names the expiry date in the user message', () => {
    expect(cursorOAuthExpiredMessage(EXPIRED)).toMatch(/expired on 2026-10-18/);
  });
});
