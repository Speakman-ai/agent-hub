import { createHash, createHmac, randomBytes, timingSafeEqual, type BinaryLike } from 'crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SEC = 30;
const TOTP_DIGITS = 6;
const TOTP_ALGORITHM = 'SHA1';
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_GROUPS = 3;
const RECOVERY_CODE_GROUP_LEN = 4;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_HASH_PREFIX = 'agent-hub-mfa-recovery-v1:';
const MFA_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface TotpVerifyResult {
  ok: boolean;
  step?: number;
}

export interface MfaLoginChallenge {
  id: string;
  userId: string;
  username: string;
  role: 'Owner' | 'Admin' | 'User';
  expiresAt: number;
  attempts: number;
}

const challenges = new Map<string, MfaLoginChallenge>();

function randomInt(maxExclusive: number): number {
  const bytes = randomBytes(4);
  return bytes.readUInt32BE(0) % maxExclusive;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function buildTotpProvisioningUri(opts: {
  issuer?: string;
  accountName: string;
  secret: string;
}): string {
  const issuer = opts.issuer || 'Agent Hub';
  const label = `${issuer}:${opts.accountName}`;
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer,
    algorithm: TOTP_ALGORITHM,
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SEC),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateTotpCode(secret: string, nowMs = Date.now()): string {
  return generateTotpCodeForStep(secret, totpStep(nowMs));
}

export function verifyTotpCode(
  secret: string,
  code: string,
  opts: { nowMs?: number; window?: number; rejectStepAtOrBefore?: number | null } = {},
): TotpVerifyResult {
  const normalized = normalizeTotpCode(code);
  if (!normalized) return { ok: false };
  const nowStep = totpStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? 1;
  for (let offset = -window; offset <= window; offset++) {
    const step = nowStep + offset;
    if (step < 0) continue;
    if (opts.rejectStepAtOrBefore != null && step <= opts.rejectStepAtOrBefore) continue;
    const expected = generateTotpCodeForStep(secret, step);
    if (safeEqual(normalized, expected)) return { ok: true, step };
  }
  return { ok: false };
}

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const groups: string[] = [];
    for (let g = 0; g < RECOVERY_CODE_GROUPS; g++) {
      let group = '';
      for (let c = 0; c < RECOVERY_CODE_GROUP_LEN; c++) {
        group += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
      }
      groups.push(group);
    }
    codes.push(groups.join('-'));
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256')
    .update(RECOVERY_HASH_PREFIX)
    .update(normalizeRecoveryCode(code), 'utf8')
    .digest('hex');
}

export function hashRecoveryCodes(codes: string[]): string[] {
  return codes.map((code) => hashRecoveryCode(code));
}

export function findRecoveryCodeHash(code: string, hashes: string[]): string | null {
  const candidate = hashRecoveryCode(code);
  for (const hash of hashes) {
    if (safeEqual(candidate, hash)) return hash;
  }
  return null;
}

export function issueMfaLoginChallenge(opts: {
  userId: string;
  username: string;
  role: 'Owner' | 'Admin' | 'User';
  nowMs?: number;
}): MfaLoginChallenge {
  pruneExpiredChallenges(opts.nowMs ?? Date.now());
  const id = `mfa_${randomBytes(24).toString('base64url')}`;
  const challenge: MfaLoginChallenge = {
    id,
    userId: opts.userId,
    username: opts.username,
    role: opts.role,
    expiresAt: (opts.nowMs ?? Date.now()) + MFA_CHALLENGE_TTL_MS,
    attempts: 0,
  };
  challenges.set(id, challenge);
  return challenge;
}

export function consumeMfaLoginChallenge(id: string, nowMs = Date.now()): MfaLoginChallenge | null {
  const challenge = challenges.get(id);
  if (!challenge || challenge.expiresAt <= nowMs) {
    if (challenge) challenges.delete(id);
    return null;
  }
  return challenge;
}

export function clearMfaLoginChallenge(id: string): void {
  challenges.delete(id);
}

export function incrementMfaLoginChallengeAttempt(id: string): number {
  const challenge = challenges.get(id);
  if (!challenge) return 0;
  challenge.attempts += 1;
  return challenge.attempts;
}

export function resetMfaChallengeStateForTests(): void {
  challenges.clear();
}

function pruneExpiredChallenges(nowMs: number): void {
  for (const [id, challenge] of challenges) {
    if (challenge.expiresAt <= nowMs) challenges.delete(id);
  }
}

function normalizeTotpCode(code: string): string | null {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().replace(/\s+/g, '');
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function totpStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);
}

function generateTotpCodeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step), 0);
  const digest = createHmac('sha1', key as BinaryLike)
    .update(msg)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(secret: string): Buffer {
  const cleaned = secret.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx < 0) throw new Error('invalid base32 secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
