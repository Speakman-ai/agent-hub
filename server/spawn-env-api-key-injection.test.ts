import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { createApiKey } from './api-keys-store.js';
import { writeSpawnCredsFile } from './spawn-creds-file.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import { buildSpawnEnv } from './config.js';
import type { AppConfig } from './types.js';

describe('buildSpawnEnv — spawn-creds token in AGENT_HUB_API_KEY', () => {
  let dataDir: string;
  let userId: string;
  let cfg: AppConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'spawn-env-key-'));
    const orgsDir = mkdtempSync(path.join(os.tmpdir(), 'spawn-env-key-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDir, 'orgs.db'));
    initOrgsDb();
    userId = createUser({
      username: `env-key-user-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    cfg = { dataDir, apiKey: null } as AppConfig;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('injects a freshly minted spawn token when cfg.apiKey is unset', () => {
    const sessionId = 'sess-env-inject-1';
    const env = buildSpawnEnv(cfg, {
      sessionId,
      spawnCredsUserId: userId,
      userId,
    });
    expect(env.AGENT_HUB_API_KEY).toBeTruthy();
    expect(env.AGENT_HUB_API_KEY).toMatch(/^ahub_/);
    expect(env.AGENT_HUB_DATA_DIR).toBe(dataDir);
  });

  it('reuses an existing on-disk spawn token without reminting', () => {
    const sessionId = 'sess-env-reuse';
    const first = createApiKey(userId, `spawn:${sessionId}`, 7);
    writeSpawnCredsFile(sessionId, first.token, dataDir);

    const env = buildSpawnEnv(cfg, {
      sessionId,
      spawnCredsUserId: userId,
      userId,
    });
    expect(env.AGENT_HUB_API_KEY).toBe(first.token);
  });

  it('does not override AGENT_HUB_API_KEY when cfg.apiKey is set', () => {
    const sessionId = 'sess-global';
    const globalCfg = { ...cfg, apiKey: 'ahub_global_break_glass' } as AppConfig;
    const env = buildSpawnEnv(globalCfg, {
      sessionId,
      spawnCredsUserId: userId,
      userId,
    });
    expect(env.AGENT_HUB_API_KEY).toBe('ahub_global_break_glass');
  });
});
