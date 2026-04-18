/**
 * Password hashing + verification using Node's built-in `scrypt`.
 *
 * We store passwords as `scrypt$N$r$p$saltHex$hashHex` strings — all
 * parameters are embedded so we can tune cost parameters later without
 * invalidating existing hashes. scrypt is memory-hard and a good default
 * when we don't want to pull in a C-compiled dep like bcrypt.
 *
 * N = 16384 (2^14), r = 8, p = 1 matches the Node docs' conservative
 * defaults. Key length is 64 bytes.
 */
import { scrypt, randomBytes, timingSafeEqual } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;
const SALT_BYTES = 16;

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r: R, p: P }, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/** Hash a plaintext password. Format: `scrypt$N$r$p$saltHex$hashHex`. */
export async function hashPassword(password: string): Promise<string> {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('hashPassword: password must be a non-empty string');
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEYLEN);
  return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verify a plaintext password against a stored `scrypt$...` hash. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const p = parseInt(parts[3], 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expected = Buffer.from(parts[5], 'hex');
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const derived = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, expected.length, { N: n, r, p }, (err, buf) => {
      if (err) reject(err);
      else resolve(buf);
    });
  }).catch(() => null);
  if (!derived) return false;
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
