/**
 * Tests for pr-env-store: encryption, masking, partial-preserving writes,
 * and the one-shot file→DB migration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  PR_ENV_CONFIG_SCHEMA,
  readPrEnvConfigMasked,
  readPrEnvConfigRow,
  writePrEnvConfig,
  encryptSecret,
  decryptSecret,
  migrateFileConfigToDb,
  prEnvConfigRowExists,
  MASK,
  __resetPrEnvStoreForTests,
  __setPrEnvKeyFilePathForTests,
} from './pr-env-store.js';

let keyDir: string;
let db: Database.Database;

beforeEach(() => {
  keyDir = mkdtempSync(path.join(tmpdir(), 'pr-env-store-'));
  __setPrEnvKeyFilePathForTests(path.join(keyDir, 'key'));
  db = new Database(':memory:');
  db.exec(PR_ENV_CONFIG_SCHEMA);
});

afterEach(() => {
  db.close();
  rmSync(keyDir, { recursive: true, force: true });
  __resetPrEnvStoreForTests();
});

describe('encryption round-trip', () => {
  it('encrypts and decrypts a secret', () => {
    const plain = 'super-secret-private-key-contents';
    const enc = encryptSecret(plain);
    expect(enc).not.toContain(plain);
    expect(enc.split(':').length).toBe(3);
    expect(decryptSecret(enc)).toBe(plain);
  });

  it('returns empty for empty input', () => {
    expect(encryptSecret('')).toBe('');
    expect(decryptSecret('')).toBe('');
  });

  it('produces distinct ciphertexts for same plaintext (random iv)', () => {
    const a = encryptSecret('same');
    const b = encryptSecret('same');
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe('same');
    expect(decryptSecret(b)).toBe('same');
  });

  it('throws on malformed ciphertext', () => {
    expect(() => decryptSecret('not:even')).toThrow(/Malformed ciphertext/);
  });
});

describe('encryption key file on disk', () => {
  it('creates the key file on first encrypt with 0o600 mode', () => {
    const keyPath = path.join(keyDir, 'key');
    expect(existsSync(keyPath)).toBe(false);
    encryptSecret('trigger-key-creation');
    expect(existsSync(keyPath)).toBe(true);
    // 0o777 mask off file-type bits; on POSIX this must be exactly 0o600.
    // Skip the assertion on platforms where chmod is a no-op (Windows).
    if (process.platform !== 'win32') {
      const mode = statSync(keyPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }
    // File contents are the hex-encoded 32-byte key.
    const contents = readFileSync(keyPath, 'utf-8').trim();
    expect(contents).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reuses the existing key on a second boot instead of regenerating', () => {
    const keyPath = path.join(keyDir, 'key');
    // First "boot" — writes a secret and creates the key.
    const ciphertext = encryptSecret('persisted-across-boots');
    const firstKey = readFileSync(keyPath, 'utf-8').trim();

    // Simulate restart — clear in-memory cache but keep the key file.
    __resetPrEnvStoreForTests();
    __setPrEnvKeyFilePathForTests(keyPath);

    // Second "boot" must load the same key and decrypt the old ciphertext.
    expect(decryptSecret(ciphertext)).toBe('persisted-across-boots');
    const secondKey = readFileSync(keyPath, 'utf-8').trim();
    expect(secondKey).toBe(firstKey);
  });
});

describe('readPrEnvConfigRow / writePrEnvConfig', () => {
  it('returns empty defaults when row does not exist', () => {
    const row = readPrEnvConfigRow(db);
    expect(row.enabled).toBe(false);
    expect(row.repoFullName).toBe('');
    expect(row.githubPrivateKey).toBe('');
    expect(prEnvConfigRowExists(db)).toBe(false);
  });

  it('writes and reads back a full row', () => {
    writePrEnvConfig(
      {
        enabled: true,
        repoFullName: 'acme/repo',
        previewHost: 'preview.example.com',
        previewBaseUrl: 'https://preview.example.com',
        certRenewalLive: true,
        portRangeMin: 4000,
        portRangeMax: 4100,
        githubAppId: '12345',
        githubInstallationId: '67890',
        githubPrivateKey: '-----BEGIN KEY-----\nABC\n-----END KEY-----',
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: 'sekret',
        route53HostedZoneId: 'Z123',
      },
      db,
    );
    const row = readPrEnvConfigRow(db);
    expect(row.enabled).toBe(true);
    expect(row.certRenewalLive).toBe(true);
    expect(row.portRangeMin).toBe(4000);
    expect(row.portRangeMax).toBe(4100);
    expect(row.githubPrivateKey).toBe('-----BEGIN KEY-----\nABC\n-----END KEY-----');
    expect(row.route53SecretAccessKey).toBe('sekret');
    expect(prEnvConfigRowExists(db)).toBe(true);
  });

  it('stores secrets encrypted at rest (not plaintext in DB)', () => {
    writePrEnvConfig(
      { githubPrivateKey: 'pk-plaintext', route53SecretAccessKey: 'aws-secret' },
      db,
    );
    const raw = db
      .prepare(
        'SELECT github_private_key_enc, route53_secret_access_key_enc FROM pr_env_config WHERE id = 1',
      )
      .get() as { github_private_key_enc: string; route53_secret_access_key_enc: string };
    expect(raw.github_private_key_enc).not.toBe('');
    expect(raw.github_private_key_enc).not.toContain('pk-plaintext');
    expect(raw.route53_secret_access_key_enc).not.toContain('aws-secret');
    // Decryption round-trips:
    const row = readPrEnvConfigRow(db);
    expect(row.githubPrivateKey).toBe('pk-plaintext');
    expect(row.route53SecretAccessKey).toBe('aws-secret');
  });
});

describe('masked read', () => {
  it('masks set secrets and leaves unset ones empty', () => {
    writePrEnvConfig(
      {
        githubAppId: '12345',
        githubPrivateKey: 'pk',
        route53AccessKeyId: 'AKIA',
        route53SecretAccessKey: '',
      },
      db,
    );
    const masked = readPrEnvConfigMasked(db);
    expect(masked.githubAppId).toBe('12345');
    expect(masked.githubPrivateKey).toBe(MASK);
    expect(masked.route53AccessKeyId).toBe('AKIA');
    expect(masked.route53SecretAccessKey).toBe('');
  });
});

describe('partial-preserving writes', () => {
  beforeEach(() => {
    writePrEnvConfig(
      {
        enabled: true,
        repoFullName: 'acme/repo',
        githubPrivateKey: 'ORIGINAL-PK',
        route53SecretAccessKey: 'ORIGINAL-AWS',
      },
      db,
    );
  });

  it('undefined leaves existing value intact', () => {
    writePrEnvConfig({ repoFullName: 'acme/other' }, db);
    const row = readPrEnvConfigRow(db);
    expect(row.repoFullName).toBe('acme/other');
    expect(row.githubPrivateKey).toBe('ORIGINAL-PK'); // preserved
    expect(row.route53SecretAccessKey).toBe('ORIGINAL-AWS');
    expect(row.enabled).toBe(true); // not in payload → kept
  });

  it('MASK sentinel preserves existing secret', () => {
    writePrEnvConfig(
      {
        githubPrivateKey: MASK,
        route53SecretAccessKey: MASK,
      },
      db,
    );
    const row = readPrEnvConfigRow(db);
    expect(row.githubPrivateKey).toBe('ORIGINAL-PK');
    expect(row.route53SecretAccessKey).toBe('ORIGINAL-AWS');
  });

  it('empty string explicitly clears a secret', () => {
    writePrEnvConfig({ githubPrivateKey: '' }, db);
    const row = readPrEnvConfigRow(db);
    expect(row.githubPrivateKey).toBe('');
    // The encrypted column should be empty too (not "encrypted empty string")
    const raw = db
      .prepare('SELECT github_private_key_enc FROM pr_env_config WHERE id = 1')
      .get() as { github_private_key_enc: string };
    expect(raw.github_private_key_enc).toBe('');
  });

  it('non-masked value overwrites secret', () => {
    writePrEnvConfig({ githubPrivateKey: 'NEW-PK' }, db);
    const row = readPrEnvConfigRow(db);
    expect(row.githubPrivateKey).toBe('NEW-PK');
  });

  it('singleton enforcement — never creates a second row', () => {
    writePrEnvConfig({ repoFullName: 'a' }, db);
    writePrEnvConfig({ repoFullName: 'b' }, db);
    writePrEnvConfig({ repoFullName: 'c' }, db);
    const count = db.prepare('SELECT COUNT(*) as n FROM pr_env_config').get() as { n: number };
    expect(count.n).toBe(1);
  });
});

describe('migrateFileConfigToDb', () => {
  it('no-ops when row already exists', () => {
    writePrEnvConfig({ repoFullName: 'pre-existing/repo' }, db);
    const migrated = migrateFileConfigToDb(
      { prEnv: { repoFullName: 'file/repo', github: { appId: '99' } } },
      db,
    );
    expect(migrated).toBe(false);
    expect(readPrEnvConfigRow(db).repoFullName).toBe('pre-existing/repo');
  });

  it('no-ops when file config has no prEnv block', () => {
    expect(migrateFileConfigToDb({}, db)).toBe(false);
    expect(migrateFileConfigToDb(undefined, db)).toBe(false);
    expect(prEnvConfigRowExists(db)).toBe(false);
  });

  it('no-ops when prEnv block is empty / has no meaningful content', () => {
    expect(migrateFileConfigToDb({ prEnv: {} }, db)).toBe(false);
    expect(prEnvConfigRowExists(db)).toBe(false);
  });

  it('copies Tier-1 + Tier-2 fields into DB row', () => {
    const migrated = migrateFileConfigToDb(
      {
        prEnv: {
          enabled: true,
          repoFullName: 'acme/repo',
          previewBaseUrl: 'https://preview.example.com',
          certRenewalLive: true,
          portRange: { min: 3100, max: 3999 },
          github: { appId: '1', installationId: '2', privateKey: 'pk' },
          route53: {
            accessKeyId: 'AKIA',
            secretAccessKey: 'sekret',
            hostedZoneId: 'Z1',
          },
          nginx: { previewHost: 'preview.example.com' },
        },
      },
      db,
    );
    expect(migrated).toBe(true);
    const row = readPrEnvConfigRow(db);
    expect(row.enabled).toBe(true);
    expect(row.repoFullName).toBe('acme/repo');
    expect(row.previewHost).toBe('preview.example.com');
    expect(row.previewBaseUrl).toBe('https://preview.example.com');
    expect(row.certRenewalLive).toBe(true);
    expect(row.portRangeMin).toBe(3100);
    expect(row.portRangeMax).toBe(3999);
    expect(row.githubAppId).toBe('1');
    expect(row.githubInstallationId).toBe('2');
    expect(row.githubPrivateKey).toBe('pk');
    expect(row.route53SecretAccessKey).toBe('sekret');
    expect(row.route53HostedZoneId).toBe('Z1');
  });

  it('is idempotent — second call no-ops', () => {
    const a = migrateFileConfigToDb(
      { prEnv: { repoFullName: 'acme/repo', github: { appId: '1' } } },
      db,
    );
    const b = migrateFileConfigToDb(
      { prEnv: { repoFullName: 'other/repo', github: { appId: '99' } } },
      db,
    );
    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(readPrEnvConfigRow(db).repoFullName).toBe('acme/repo');
  });
});
