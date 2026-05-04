/**
 * PR-env configuration store.
 *
 * Backs the `/settings/pr-environments` Settings page. The DB row is a
 * singleton (enforced by `CHECK(id=1)` on the table) — v1 is deliberately
 * single-repo; per-project config is a non-goal until the second-repo
 * request lands.
 *
 * Tiering (matches the task spec):
 *   - Tier 1 (General)     — stored here, in DB, surfaced in the UI
 *   - Tier 2 (Credentials) — stored here, ENCRYPTED AT REST, surfaced masked
 *   - Tier 3 (host paths)  — left in `config.json`; not the UI's job
 *
 * Secrets are encrypted with AES-256-GCM using a per-install key stored
 * at `<dataDir>/pr-env-secret.key` (0600). This is the first AES-256-GCM
 * at-rest secret in the codebase — no shared key file with other
 * subsystems yet. The key is auto-generated on first write so installs
 * don't need to pre-provision anything. Lost key = lost secrets (same
 * failure mode as losing `auth.json`'s jwtSecret).
 *
 * The store exposes three shapes:
 *   - `readPrEnvConfigRow()` — raw DB row, no masking (used by runtime).
 *   - `readPrEnvConfigMasked()` — for GET /api/settings/pr-env; secrets
 *     replaced with `••••••••` (`MASK`) when set.
 *   - `writePrEnvConfig(partial)` — PUT; fields that are null / undefined /
 *     equal to `MASK` are preserved, so a partial save from the UI doesn't
 *     wipe secrets the user didn't re-enter.
 */

import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import config from './config.js';
import { getDb } from './db.js';
import { PR_ENV_CONFIG_SCHEMA } from './pr-env-schema.js';

// Re-export so existing test imports (`from './pr-env-store.js'`) keep working
// while db.ts and prod code consume the canonical definition from
// `./pr-env-schema.js`. Prevents DDL drift between prod and tests.
export { PR_ENV_CONFIG_SCHEMA };

export const MASK = '••••••••';

/** Raw (plaintext) shape of the `pr_env_config` singleton row. */
export interface PrEnvConfigRow {
  enabled: boolean;
  repoFullName: string;
  previewHost: string;
  previewBaseUrl: string;
  certRenewalLive: boolean;
  portRangeMin: number | null;
  portRangeMax: number | null;
  route53AccessKeyId: string;
  route53SecretAccessKey: string;
  route53HostedZoneId: string;
}

/**
 * Masked shape returned from GET — secrets are `MASK` when set and `''`
 * when unset so the UI can distinguish "unconfigured" from "has value".
 */
export interface PrEnvConfigMasked {
  enabled: boolean;
  repoFullName: string;
  previewHost: string;
  previewBaseUrl: string;
  certRenewalLive: boolean;
  portRangeMin: number | null;
  portRangeMax: number | null;
  route53AccessKeyId: string;
  /** `MASK` when set, `''` when unset. */
  route53SecretAccessKey: string;
  route53HostedZoneId: string;
}

/**
 * Partial write payload. Any field left `undefined` OR explicitly equal to
 * the mask sentinel is preserved. This lets the UI post the whole form
 * back without knowing which secrets the user actually touched.
 */
export type PrEnvConfigWrite = Partial<PrEnvConfigRow>;

// ─── Encryption key management ─────────────────────────────────────────────

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
        `[pr-env-store] Invalid encryption key at ${keyPath} — expected 64 hex chars`,
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
    throw new Error('[pr-env-store] Malformed ciphertext blob — expected iv:tag:ciphertext');
  }
  const [ivB64, tagB64, encB64] = parts;
  const key = loadOrCreateKey();
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]);
  return dec.toString('utf-8');
}

// ─── Table schema ──────────────────────────────────────────────────────────
// DDL is defined in ./pr-env-schema.ts and applied by db.ts at init time.
// Re-exported at the top of this file for back-compat with existing tests.

interface RawRow {
  id: number;
  enabled: number;
  repo_full_name: string;
  preview_host: string;
  preview_base_url: string;
  cert_renewal_live: number;
  port_range_min: number | null;
  port_range_max: number | null;
  route53_access_key_id: string;
  route53_secret_access_key_enc: string;
  route53_hosted_zone_id: string;
}

const EMPTY_ROW: PrEnvConfigRow = {
  enabled: false,
  repoFullName: '',
  previewHost: '',
  previewBaseUrl: '',
  certRenewalLive: false,
  portRangeMin: null,
  portRangeMax: null,
  route53AccessKeyId: '',
  route53SecretAccessKey: '',
  route53HostedZoneId: '',
};

function hydrate(raw: RawRow): PrEnvConfigRow {
  return {
    enabled: raw.enabled === 1,
    repoFullName: raw.repo_full_name,
    previewHost: raw.preview_host,
    previewBaseUrl: raw.preview_base_url,
    certRenewalLive: raw.cert_renewal_live === 1,
    portRangeMin: raw.port_range_min,
    portRangeMax: raw.port_range_max,
    route53AccessKeyId: raw.route53_access_key_id,
    route53SecretAccessKey: raw.route53_secret_access_key_enc
      ? decryptSecret(raw.route53_secret_access_key_enc)
      : '',
    route53HostedZoneId: raw.route53_hosted_zone_id,
  };
}

function fetchRaw(db: Database.Database): RawRow | undefined {
  return db.prepare('SELECT * FROM pr_env_config WHERE id = 1').get() as RawRow | undefined;
}

/** Raw (plaintext) read. Missing row → empty-default shape. */
export function readPrEnvConfigRow(db: Database.Database = getDb()): PrEnvConfigRow {
  const raw = fetchRaw(db);
  if (!raw) return { ...EMPTY_ROW };
  return hydrate(raw);
}

/** Masked read for GET /api/settings/pr-env. */
export function readPrEnvConfigMasked(db: Database.Database = getDb()): PrEnvConfigMasked {
  const row = readPrEnvConfigRow(db);
  return {
    enabled: row.enabled,
    repoFullName: row.repoFullName,
    previewHost: row.previewHost,
    previewBaseUrl: row.previewBaseUrl,
    certRenewalLive: row.certRenewalLive,
    portRangeMin: row.portRangeMin,
    portRangeMax: row.portRangeMax,
    route53AccessKeyId: row.route53AccessKeyId,
    route53SecretAccessKey: row.route53SecretAccessKey ? MASK : '',
    route53HostedZoneId: row.route53HostedZoneId,
  };
}

/**
 * Merge a partial update into the singleton row.
 *
 * Preservation rules (prevents partial UI saves from wiping secrets):
 *   - `undefined`  → keep existing
 *   - `MASK`       → keep existing (UI sends `MASK` for untouched secret fields)
 *   - `''`         → write-through (user explicitly cleared the field)
 *   - anything else → write-through
 *
 * Returns the resulting masked view so the UI can re-render immediately.
 */
export function writePrEnvConfig(
  partial: PrEnvConfigWrite,
  db: Database.Database = getDb(),
): PrEnvConfigMasked {
  const existing = readPrEnvConfigRow(db);

  const pick = <K extends keyof PrEnvConfigRow>(key: K): PrEnvConfigRow[K] => {
    const next = partial[key];
    if (next === undefined) return existing[key];
    // Secrets: UI sends MASK for fields the user didn't touch — preserve.
    if (key === 'route53SecretAccessKey' && typeof next === 'string' && next === MASK) {
      return existing[key];
    }
    return next as PrEnvConfigRow[K];
  };

  const merged: PrEnvConfigRow = {
    enabled: pick('enabled'),
    repoFullName: pick('repoFullName'),
    previewHost: pick('previewHost'),
    previewBaseUrl: pick('previewBaseUrl'),
    certRenewalLive: pick('certRenewalLive'),
    portRangeMin: pick('portRangeMin'),
    portRangeMax: pick('portRangeMax'),
    route53AccessKeyId: pick('route53AccessKeyId'),
    route53SecretAccessKey: pick('route53SecretAccessKey'),
    route53HostedZoneId: pick('route53HostedZoneId'),
  };

  const route53SkEnc = merged.route53SecretAccessKey
    ? encryptSecret(merged.route53SecretAccessKey)
    : '';

  db.prepare(
    `INSERT INTO pr_env_config (
       id, enabled, repo_full_name, preview_host, preview_base_url,
       cert_renewal_live, port_range_min, port_range_max,
       route53_access_key_id, route53_secret_access_key_enc,
       route53_hosted_zone_id, updated_at
     ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       enabled = excluded.enabled,
       repo_full_name = excluded.repo_full_name,
       preview_host = excluded.preview_host,
       preview_base_url = excluded.preview_base_url,
       cert_renewal_live = excluded.cert_renewal_live,
       port_range_min = excluded.port_range_min,
       port_range_max = excluded.port_range_max,
       route53_access_key_id = excluded.route53_access_key_id,
       route53_secret_access_key_enc = excluded.route53_secret_access_key_enc,
       route53_hosted_zone_id = excluded.route53_hosted_zone_id,
       updated_at = excluded.updated_at`,
  ).run(
    merged.enabled ? 1 : 0,
    merged.repoFullName,
    merged.previewHost,
    merged.previewBaseUrl,
    merged.certRenewalLive ? 1 : 0,
    merged.portRangeMin,
    merged.portRangeMax,
    merged.route53AccessKeyId,
    route53SkEnc,
    merged.route53HostedZoneId,
  );

  return readPrEnvConfigMasked(db);
}

/** Returns true iff the DB row exists (has been written at least once). */
export function prEnvConfigRowExists(db: Database.Database = getDb()): boolean {
  return !!fetchRaw(db);
}

// ─── File → DB one-shot migration ──────────────────────────────────────────

interface FilePrEnvBlock {
  enabled?: boolean;
  repoFullName?: string;
  previewBaseUrl?: string;
  certRenewalLive?: boolean;
  portRange?: { min?: number; max?: number };
  /**
   * Legacy: previously held a per-PR-env GitHub App. Ignored on migration —
   * the dispatcher reuses the registered Reviewer App
   * (`AppConfig.githubApp`) as the sole source. Kept in the type so old
   * `config.json` files don't fail to deserialize.
   */
  github?: { appId?: string; installationId?: string; privateKey?: string };
  route53?: { accessKeyId?: string; secretAccessKey?: string; hostedZoneId?: string };
  nginx?: { previewHost?: string };
}

/**
 * One-shot migration: if the DB row is empty and `config.json` has a
 * populated `prEnv` block, copy Tier-1 and Tier-2 fields into the DB
 * transparently. Idempotent — no-op once the row exists.
 *
 * Returns true when a migration was performed, false otherwise (already
 * migrated, no file block, or feature disabled everywhere).
 */
export function migrateFileConfigToDb(
  fileConfig: Record<string, unknown> | undefined,
  db: Database.Database = getDb(),
): boolean {
  if (prEnvConfigRowExists(db)) return false;
  const block = (fileConfig?.prEnv as FilePrEnvBlock | undefined) ?? undefined;
  if (!block) return false;

  // Only migrate if the block has at least one non-trivial field — avoids
  // stamping an empty row on an install that touched `prEnv: {}` once.
  // The legacy `github.*` fields no longer count towards "non-trivial"
  // because they aren't migrated; carrying them alone shouldn't trigger a
  // DB write.
  const hasContent =
    !!block.repoFullName ||
    !!block.previewBaseUrl ||
    !!block.route53?.accessKeyId ||
    !!block.nginx?.previewHost;
  if (!hasContent) return false;

  writePrEnvConfig(
    {
      enabled: block.enabled === true,
      repoFullName: block.repoFullName ?? '',
      previewHost: block.nginx?.previewHost ?? '',
      previewBaseUrl: block.previewBaseUrl ?? '',
      certRenewalLive: block.certRenewalLive === true,
      portRangeMin: block.portRange?.min ?? null,
      portRangeMax: block.portRange?.max ?? null,
      route53AccessKeyId: block.route53?.accessKeyId ?? '',
      route53SecretAccessKey: block.route53?.secretAccessKey ?? '',
      route53HostedZoneId: block.route53?.hostedZoneId ?? '',
    },
    db,
  );
  return true;
}

// ─── Test hooks ────────────────────────────────────────────────────────────

/** Reset cached key / key path — for tests that use tmp dirs. */
export function __resetPrEnvStoreForTests(): void {
  cachedKey = null;
  cachedKeyPath = null;
}

/** Override the encryption-key file path. Test-only. */
export function __setPrEnvKeyFilePathForTests(p: string | null): void {
  cachedKeyPath = p;
  cachedKey = null;
}
