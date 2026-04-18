import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signJwt, verifyJwt } from './jwt.js';

describe('signJwt / verifyJwt', () => {
  const SECRET = 'unit-test-secret-do-not-use-in-prod';

  it('round-trips a subject and custom claims', () => {
    const token = signJwt('alice', SECRET, { claims: { role: 'owner' } });
    const result = verifyJwt(token, SECRET);
    expect(result.ok).toBe(true);
    expect(result.payload!.sub).toBe('alice');
    expect(result.payload!.role).toBe('owner');
    expect(typeof result.payload!.iat).toBe('number');
    expect(typeof result.payload!.exp).toBe('number');
    expect(result.payload!.exp).toBeGreaterThan(result.payload!.iat);
  });

  it('rejects a token signed with a different secret', () => {
    const token = signJwt('alice', SECRET);
    const result = verifyJwt(token, 'other-secret');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects a tampered payload', () => {
    const token = signJwt('alice', SECRET);
    const parts = token.split('.');
    // Replace the payload with base64url("{\"sub\":\"eve\",\"iat\":0,\"exp\":9999999999}")
    const forgedPayload = Buffer.from(JSON.stringify({ sub: 'eve', iat: 0, exp: 9_999_999_999 }))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const tampered = `${parts[0]}.${forgedPayload}.${parts[2]}`;
    const result = verifyJwt(tampered, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-signature');
  });

  it('rejects malformed tokens', () => {
    expect(verifyJwt('', SECRET).ok).toBe(false);
    expect(verifyJwt('not-a-jwt', SECRET).ok).toBe(false);
    expect(verifyJwt('a.b', SECRET).reason).toBe('malformed');
  });

  it('rejects non-HS256 algorithms', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const payload = Buffer.from(JSON.stringify({ sub: 'alice', iat: 0, exp: 9_999_999_999 }))
      .toString('base64')
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
    const forged = `${header}.${payload}.`;
    const result = verifyJwt(forged, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('bad-algorithm');
  });

  it('rejects expired tokens', () => {
    // Sign with -1s lifetime to get an already-expired token deterministically.
    const token = signJwt('alice', SECRET, { expiresInSec: -1 });
    const result = verifyJwt(token, SECRET);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('expired');
  });

  it('respects the expiresInSec option', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signJwt('alice', SECRET, { expiresInSec: 60 });
    const result = verifyJwt(token, SECRET);
    expect(result.ok).toBe(true);
    expect(result.payload!.exp).toBeGreaterThanOrEqual(before + 59);
    expect(result.payload!.exp).toBeLessThanOrEqual(before + 61);
  });

  it('throws when no secret is provided at signing time', () => {
    expect(() => signJwt('alice', '')).toThrow();
  });
});
