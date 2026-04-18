/**
 * Minimal HS256 JWT sign/verify using Node's built-in `crypto` module.
 *
 * We deliberately avoid adding a `jsonwebtoken` dependency for Phase 1 —
 * this is a tiny, auditable implementation of the pieces we actually need:
 *
 *   - HS256 signing (HMAC-SHA256 with a shared secret)
 *   - Base64url encoding of the header + payload
 *   - Signature verification with constant-time compare
 *   - `exp` (expiry) enforcement
 *
 * If/when the auth feature set grows (refresh tokens, JWK rotation,
 * asymmetric keys) we can swap to `jsonwebtoken` or `jose` without changing
 * callers — the `signJwt` / `verifyJwt` contract stays the same.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
  [claim: string]: unknown;
}

function base64urlEncode(buf: Buffer | string): string {
  const b = typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf;
  return b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function sign(payload: string, secret: string): string {
  return base64urlEncode(createHmac('sha256', secret).update(payload).digest());
}

export interface SignOptions {
  /** Token lifetime in seconds. Default 7 days. */
  expiresInSec?: number;
  /** Extra claims to merge into the payload. */
  claims?: Record<string, unknown>;
}

/** Sign an HS256 JWT. Returns the compact token string. */
export function signJwt(subject: string, secret: string, options: SignOptions = {}): string {
  if (!secret) throw new Error('signJwt: secret is required');
  const { expiresInSec = 7 * 24 * 60 * 60, claims = {} } = options;
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JwtPayload = {
    ...claims,
    sub: subject,
    iat: now,
    exp: now + expiresInSec,
  };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign(signingInput, secret);
  return `${signingInput}.${signature}`;
}

export interface VerifyResult {
  ok: boolean;
  /** Populated when `ok` is true. */
  payload?: JwtPayload;
  /** Human-readable reason the token was rejected. */
  reason?: 'malformed' | 'bad-algorithm' | 'bad-signature' | 'expired' | 'bad-payload';
}

/**
 * Verify an HS256 JWT against a shared secret. Enforces `exp`. Returns a
 * discriminated result so callers can distinguish "expired" from "forged".
 */
export function verifyJwt(token: string, secret: string): VerifyResult {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'malformed' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: { alg?: string; typ?: string };
  try {
    header = JSON.parse(base64urlDecode(encodedHeader).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (header.alg !== 'HS256') return { ok: false, reason: 'bad-algorithm' };

  const expected = sign(`${encodedHeader}.${encodedPayload}`, secret);
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(encodedSignature);
  if (expectedBuf.length !== providedBuf.length || !timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'bad-signature' };
  }

  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecode(encodedPayload).toString('utf8')) as JwtPayload;
  } catch {
    return { ok: false, reason: 'bad-payload' };
  }
  if (typeof payload.exp !== 'number' || typeof payload.sub !== 'string') {
    return { ok: false, reason: 'bad-payload' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) return { ok: false, reason: 'expired' };

  return { ok: true, payload };
}
