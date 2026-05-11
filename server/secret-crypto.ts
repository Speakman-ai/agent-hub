/**
 * Shared AES-256-GCM helpers for at-rest secret storage.
 *
 * Originally lived in `pr-env-store.ts` alongside the now-deleted
 * `pr_env_config` table. The same key file is reused by every subsystem
 * that needs to encrypt user-supplied secrets at rest:
 *
 *   - Slack bot tokens (`server/slack.ts`, `server/routes/slack.ts`)
 *   - Per-user skill credentials (`server/skill-credentials-store.ts`)
 *
 * The key file (`<dataDir>/pr-env-secret.key`) is unchanged so existing
 * encrypted blobs decrypt correctly across the PR-env removal epic.
 * Renaming the file would be a backwards-incompatible migration; keeping
 * it pinned avoids that headache. The file name is a historical artifact
 * — the secret itself is install-wide.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import config from './config.js';

export const MASK = '••••••••';

let cachedKeyPath: string | null = null;
let cachedKey: Buffer | null = null;

function keyFilePath(): string {
  if (cachedKeyPath) return cachedKeyPath;
  cachedKeyPath = path.join(config.dataDir, 'pr-env-secret.key');
  return cachedKeyPath;
}

function loadOrCreateKey(): Buffer {
  if (cachedKey) return cachedKey;
  const keyPath = keyFilePath();
  mkdirSync(path.dirname(keyPath), { recursive: true });
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf-8').trim();
    if (hex.length !== 64) {
      throw new Error(
        `[secret-crypto] Invalid encryption key at ${keyPath} — expected 64 hex chars`,
      );
    }
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }
  const fresh = randomBytes(32);
  writeFileSync(keyPath, fresh.toString('hex'), { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600);
  } catch {
    /* best-effort — file was just written with 0600 */
  }
  cachedKey = fresh;
  return cachedKey;
}

/**
 * Encrypt a plaintext string to a `iv:tag:ciphertext` base64 triple.
 * Empty input returns empty output so the caller can treat "no secret"
 * symmetrically on read/write without stashing an encrypted empty string.
 */
export function encryptSecret(plaintext: string): string {
  if (!plaintext) return '';
  const key = loadOrCreateKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(blob: string): string {
  if (!blob) return '';
  const parts = blob.split(':');
  if (parts.length !== 3) {
    throw new Error('[secret-crypto] Malformed ciphertext blob — expected iv:tag:ciphertext');
  }
  const [ivB64, tagB64, encB64] = parts;
  const key = loadOrCreateKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return dec.toString('utf-8');
}

// ─── Test hooks ────────────────────────────────────────────────────────────

/** Reset cached key / key path — for tests that use tmp dirs. */
export function __resetSecretCryptoForTests(): void {
  cachedKey = null;
  cachedKeyPath = null;
}

/** Override the encryption-key file path. Test-only. */
export function __setSecretCryptoKeyFilePathForTests(p: string | null): void {
  cachedKeyPath = p;
  cachedKey = null;
}
