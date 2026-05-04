/**
 * Tests for the runtime resolver. These exercise the full priority
 * chain: shared mode → env var → DB row → config.json fallback.
 *
 * The resolver imports `getOrgsDb`; the tests stand up a real
 * orgs.db in a tmp dir via `setOrgsDbPathForTests` so the resolver's
 * `readIntegrationProviderRow` call hits the same handle the test
 * writes through.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setOrgsDbPathForTests, initOrgsDb, getOrgsDb } from './orgs.js';
import { writeIntegrationProviderConfig } from './integration-provider-store.js';
import {
  __resetPrEnvStoreForTests as _resetPe,
  __setPrEnvKeyFilePathForTests as _setPe,
} from './pr-env-store.js';

import { getIntegrationProviderConfig } from './integration-provider-runtime.js';
import { fileConfig } from './config.js';

let tmpRoot: string;
let envBackup: { key?: string; webhook?: string };

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), 'int-prov-runtime-'));
  mkdirSync(tmpRoot, { recursive: true });
  setOrgsDbPathForTests(path.join(tmpRoot, 'orgs.db'));
  initOrgsDb();
  _setPe(path.join(tmpRoot, 'enc.key'));
  envBackup = {
    key: process.env.HUB_SHARED_NANGO_KEY,
    webhook: process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET,
  };
  delete process.env.HUB_SHARED_NANGO_KEY;
  delete process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET;
  // Defensive: clear any cached fileConfig.nango block from previous tests.
  delete fileConfig.nango;
});

afterEach(() => {
  try {
    getOrgsDb().close();
  } catch {
    /* not initialized */
  }
  setOrgsDbPathForTests(null);
  rmSync(tmpRoot, { recursive: true, force: true });
  _resetPe();
  if (envBackup.key === undefined) delete process.env.HUB_SHARED_NANGO_KEY;
  else process.env.HUB_SHARED_NANGO_KEY = envBackup.key;
  if (envBackup.webhook === undefined) delete process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET;
  else process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET = envBackup.webhook;
  delete fileConfig.nango;
});

describe('shared mode', () => {
  it('substitutes HUB_SHARED_NANGO_KEY for the secret', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'shared-from-env';
    process.env.HUB_SHARED_NANGO_WEBHOOK_SECRET = 'shared-wh';
    writeIntegrationProviderConfig({ mode: 'shared' }, '');
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('shared');
      expect(r.secretKey).toBe('shared-from-env');
      expect(r.webhookSecret).toBe('shared-wh');
      expect(r.source).toBe('env');
    }
  });

  it('returns shared-mode-missing-env when env var is unset', () => {
    writeIntegrationProviderConfig({ mode: 'shared' }, '');
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('shared-mode-missing-env');
  });

  it('uses default base URL when none configured', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'k';
    writeIntegrationProviderConfig({ mode: 'shared' }, '');
    const r = getIntegrationProviderConfig();
    expect(r.baseUrl).toBe('https://api.nango.dev');
  });

  it('uses DB providerBaseUrl override when set', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'k';
    writeIntegrationProviderConfig(
      { mode: 'shared', providerBaseUrl: 'https://nango.example/api' },
      '',
    );
    const r = getIntegrationProviderConfig();
    expect(r.baseUrl).toBe('https://nango.example/api');
  });
});

describe('byo mode', () => {
  it('returns DB secret when set', () => {
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: 'byo-sk', webhookSecret: 'byo-wh' },
      '',
    );
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mode).toBe('byo');
      expect(r.secretKey).toBe('byo-sk');
      expect(r.webhookSecret).toBe('byo-wh');
      expect(r.source).toBe('db');
    }
  });

  it('falls back to config.json nango block when DB row has no secret', () => {
    writeIntegrationProviderConfig({ mode: 'byo' }, '');
    fileConfig.nango = {
      secretKey: 'from-config-json',
      baseUrl: 'https://legacy.nango.example',
      webhookSecret: 'fc-wh',
    };
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.secretKey).toBe('from-config-json');
      expect(r.baseUrl).toBe('https://legacy.nango.example');
      expect(r.webhookSecret).toBe('fc-wh');
      expect(r.source).toBe('config-file');
    }
  });

  it('returns byo-mode-missing-secret when neither DB nor config has a key', () => {
    writeIntegrationProviderConfig({ mode: 'byo' }, '');
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('byo-mode-missing-secret');
  });

  it('env var does NOT shadow the BYO secret', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'should-not-leak';
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'byo-real' }, '');
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.secretKey).toBe('byo-real');
      expect(r.source).toBe('db');
    }
  });
});

describe('disabled flag', () => {
  it('returns disabled when enabled=false', () => {
    process.env.HUB_SHARED_NANGO_KEY = 'k';
    writeIntegrationProviderConfig({ mode: 'shared', enabled: false }, '');
    const r = getIntegrationProviderConfig();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('disabled');
  });
});
