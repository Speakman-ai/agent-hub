import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  createApiKey,
  verifyApiKey,
  countApiKeysForUser,
  revokeApiKeysByName,
  revokeApiKeysBySpawnSession,
} from './api-keys-store.js';
import { readSpawnCredsFile, writeSpawnCredsFile } from './spawn-creds-file.js';
import {
  cleanupSpawnCredsForSession,
  ensureSpawnCredsForSession,
  spawnCredsKeyName,
} from './spawn-creds-mint.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import type { AppConfig } from './types.js';

describe('spawn-creds-mint', () => {
  let dataDir: string;
  let userId: string;
  let cfg: AppConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'spawn-creds-mint-'));
    const orgsDir = mkdtempSync(path.join(os.tmpdir(), 'spawn-creds-mint-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDir, 'orgs.db'));
    initOrgsDb();
    userId = createUser({
      username: `mint-user-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    cfg = { dataDir, apiKey: null } as AppConfig;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes a spawn-creds file when deployment has no global apiKey', () => {
    const sessionId = 'sess-mint-001';
    ensureSpawnCredsForSession({ sessionId, ownerUserId: userId, cfg });
    const token = readSpawnCredsFile(sessionId, dataDir);
    expect(token).toBeTruthy();
    expect(verifyApiKey(token!)).toEqual({ userId, keyId: expect.any(String) });
    expect(spawnCredsKeyName(sessionId)).toBe('spawn:sess-mint-001');
  });

  it('skips minting when cfg.apiKey is set', () => {
    const sessionId = 'sess-global-key';
    ensureSpawnCredsForSession({
      sessionId,
      ownerUserId: userId,
      cfg: { ...cfg, apiKey: 'ahub_global_break_glass' } as AppConfig,
    });
    expect(readSpawnCredsFile(sessionId, dataDir)).toBeNull();
    expect(countApiKeysForUser(userId)).toBe(0);
  });

  it('reuses a valid on-disk token without creating a second key', () => {
    const sessionId = 'sess-reuse';
    const first = createApiKey(userId, spawnCredsKeyName(sessionId), 30);
    writeSpawnCredsFile(sessionId, first.token, dataDir);
    const before = countApiKeysForUser(userId);
    ensureSpawnCredsForSession({ sessionId, ownerUserId: userId, cfg });
    expect(countApiKeysForUser(userId)).toBe(before);
    expect(readSpawnCredsFile(sessionId, dataDir)).toBe(first.token);
  });

  it('revokeApiKeysBySpawnSession revokes only the matching spawn key name', () => {
    const sessionId = 'sess-revoke-by-name';
    const other = createApiKey(userId, 'human-key', null);
    createApiKey(userId, spawnCredsKeyName(sessionId), 30);
    expect(revokeApiKeysBySpawnSession(sessionId)).toBe(1);
    expect(verifyApiKey(other.token)).not.toBeNull();
    expect(revokeApiKeysByName(userId, 'human-key')).toBe(1);
    expect(verifyApiKey(other.token)).toBeNull();
  });

  it('cleanupSpawnCredsForSession revokes keys and removes the file', () => {
    const sessionId = 'sess-cleanup';
    ensureSpawnCredsForSession({ sessionId, ownerUserId: userId, cfg });
    const token = readSpawnCredsFile(sessionId, dataDir);
    expect(token).toBeTruthy();
    cleanupSpawnCredsForSession(sessionId, dataDir);
    expect(readSpawnCredsFile(sessionId, dataDir)).toBeNull();
    expect(verifyApiKey(token!)).toBeNull();
  });
});
