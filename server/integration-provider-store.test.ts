/**
 * Tests for integration-provider-store: masking, partial-preserving
 * writes, mode-switch wiping semantics, and the `sharedAvailable`
 * flag.
 *
 * The store reuses encryption from pr-env-store (same key file). The
 * tests therefore drive the per-install key file through pr-env-store's
 * test hooks (`__setPrEnvKeyFilePathForTests`) so we don't double-key
 * accidentally.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { INTEGRATION_PROVIDERS_SCHEMA } from './integration-provider-schema.js';
import {
  readIntegrationProviderMasked,
  readIntegrationProviderRow,
  writeIntegrationProviderConfig,
  integrationProviderRowExists,
  sharedNangoKeyAvailable,
  MASK,
} from './integration-provider-store.js';
import { __resetPrEnvStoreForTests, __setPrEnvKeyFilePathForTests } from './pr-env-store.js';

let keyDir: string;
let db: Database.Database;
let envBackup: string | undefined;

beforeEach(() => {
  keyDir = mkdtempSync(path.join(tmpdir(), 'int-prov-store-'));
  __setPrEnvKeyFilePathForTests(path.join(keyDir, 'key'));
  db = new Database(':memory:');
  db.exec(INTEGRATION_PROVIDERS_SCHEMA);
  envBackup = process.env.HUB_SHARED_NANGO_KEY;
  delete process.env.HUB_SHARED_NANGO_KEY;
});

afterEach(() => {
  db.close();
  rmSync(keyDir, { recursive: true, force: true });
  __resetPrEnvStoreForTests();
  if (envBackup === undefined) delete process.env.HUB_SHARED_NANGO_KEY;
  else process.env.HUB_SHARED_NANGO_KEY = envBackup;
});

describe('readIntegrationProviderMasked', () => {
  it('returns empty defaults when no row exists', () => {
    const m = readIntegrationProviderMasked(db);
    expect(m.mode).toBe('shared');
    expect(m.provider).toBe('nango-cloud');
    expect(m.hasKey).toBe(false);
    expect(m.sharedAvailable).toBe(false);
    expect(m.baseUrl).toBe('');
    expect(m.hasWebhookSecret).toBe(false);
    expect(m.enabled).toBe(true);
  });

  it('reports sharedAvailable when env var is set', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'env-key';
    expect(sharedNangoKeyAvailable()).toBe(true);
    expect(readIntegrationProviderMasked(db).sharedAvailable).toBe(true);
  });

  it('masks BYO secret with hasKey=true', () => {
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: 'nango_sk_real', providerBaseUrl: 'https://api.nango.dev' },
      'user-1',
      db,
    );
    const m = readIntegrationProviderMasked(db);
    expect(m.mode).toBe('byo');
    expect(m.hasKey).toBe(true);
    expect(m.baseUrl).toBe('https://api.nango.dev');
    // Plaintext must never appear in the masked view.
    expect(JSON.stringify(m)).not.toContain('nango_sk_real');
  });

  it('reports hasWebhookSecret independently of hasKey', () => {
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'k', webhookSecret: 'wh' }, '', db);
    const m = readIntegrationProviderMasked(db);
    expect(m.hasKey).toBe(true);
    expect(m.hasWebhookSecret).toBe(true);
  });
});

describe('writeIntegrationProviderConfig', () => {
  it('writes a new row and round-trips secrets', () => {
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: 'sk-abc', webhookSecret: 'wh-xyz' },
      'owner-1',
      db,
    );
    const row = readIntegrationProviderRow(db);
    expect(row.mode).toBe('byo');
    expect(row.secretKey).toBe('sk-abc');
    expect(row.webhookSecret).toBe('wh-xyz');
    expect(row.updatedBy).toBe('owner-1');
    expect(row.updatedAt).not.toBe('');
  });

  it('preserves existing secret when MASK is sent on PUT', () => {
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'ORIGINAL' }, '', db);
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: MASK, providerBaseUrl: 'https://example.test' },
      '',
      db,
    );
    const row = readIntegrationProviderRow(db);
    expect(row.secretKey).toBe('ORIGINAL');
    expect(row.providerBaseUrl).toBe('https://example.test');
    // And the masked GET still says hasKey=true.
    expect(readIntegrationProviderMasked(db).hasKey).toBe(true);
  });

  it("clears the secret when '' is sent (explicit user clear)", () => {
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'X' }, '', db);
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: '' }, '', db);
    expect(readIntegrationProviderRow(db).secretKey).toBe('');
    expect(readIntegrationProviderMasked(db).hasKey).toBe(false);
  });

  it('switching byo→shared wipes BYO secret ciphertext', () => {
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: 'leftover', webhookSecret: 'leftover-wh' },
      '',
      db,
    );
    writeIntegrationProviderConfig({ mode: 'shared' }, '', db);
    // Raw row inspection — ciphertext columns must be empty strings.
    const raw = db
      .prepare<
        unknown[],
        { secret_key_encrypted: string; webhook_secret_encrypted: string }
      >('SELECT secret_key_encrypted, webhook_secret_encrypted FROM integration_providers WHERE id = 1')
      .get();
    expect(raw?.secret_key_encrypted).toBe('');
    expect(raw?.webhook_secret_encrypted).toBe('');
    // Hydrated row also reports empty.
    const row = readIntegrationProviderRow(db);
    expect(row.secretKey).toBe('');
    expect(row.webhookSecret).toBe('');
  });

  it('switching shared→byo with a fresh secret stores it', () => {
    writeIntegrationProviderConfig({ mode: 'shared' }, '', db);
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'fresh-sk' }, '', db);
    expect(readIntegrationProviderRow(db).secretKey).toBe('fresh-sk');
  });

  it('integrationProviderRowExists tracks first write', () => {
    expect(integrationProviderRowExists(db)).toBe(false);
    writeIntegrationProviderConfig({ mode: 'shared' }, '', db);
    expect(integrationProviderRowExists(db)).toBe(true);
  });

  it('shared mode never persists a secret even if one is sent', () => {
    writeIntegrationProviderConfig({ mode: 'shared', secretKey: 'should-be-ignored' }, '', db);
    expect(readIntegrationProviderRow(db).secretKey).toBe('');
    expect(readIntegrationProviderMasked(db).hasKey).toBe(false);
  });

  it('shared-mode masked view never reports hasKey even with stale ciphertext', () => {
    // Manually inject a non-empty ciphertext + shared mode to simulate
    // a corrupted row. The masked view must still report hasKey=false
    // because shared mode doesn't surface BYO ciphertext.
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'leftover' }, '', db);
    db.prepare("UPDATE integration_providers SET mode = 'shared' WHERE id = 1").run();
    expect(readIntegrationProviderMasked(db).hasKey).toBe(false);
  });
});
