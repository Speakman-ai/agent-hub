import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser } from './users-store.js';
import { AutopilotWorkerCredentialError, resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import type { AppConfig } from './types.js';
import {
  autopilotSessionBindingPath,
  bindAutopilotWorkerSession,
  removeAutopilotWorkerToken,
  writeAutopilotWorkerToken,
} from './autopilot/worker-token.js';

describe('resolveSessionCliSpawnEnv — Autopilot worker identity', () => {
  let dataDir: string;
  let userId: string;
  let cfg: AppConfig;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(os.tmpdir(), 'autopilot-spawn-'));
    const orgsDir = mkdtempSync(path.join(os.tmpdir(), 'autopilot-spawn-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDir, 'orgs.db'));
    initOrgsDb();
    userId = createUser({
      username: `autopilot-spawn-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
    cfg = { dataDir, apiKey: 'ahub_global_break_glass' } as AppConfig;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('replaces the break-glass Hub key for a bound Autopilot worker session', () => {
    writeAutopilotWorkerToken('run-1', 'ahub_scoped_worker', dataDir);
    bindAutopilotWorkerSession('sess-worker', { projectId: 'demo-app', runId: 'run-1' }, dataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg,
      ownerId: userId,
      credsOwnerId: userId,
      sessionId: 'sess-worker',
      engine: 'gemini-cli',
    });

    expect(env.AGENT_HUB_API_KEY).toBe('ahub_scoped_worker');
    expect(env.PROJECT_ID).toBe('demo-app');
    expect(env.AGENT_HUB_AUTOPILOT_RUN_ID).toBe('run-1');
  });

  it('leaves a normal session on the break-glass key', () => {
    const env = resolveSessionCliSpawnEnv({
      cfg,
      ownerId: userId,
      credsOwnerId: userId,
      sessionId: 'sess-normal',
      engine: 'gemini-cli',
    });
    expect(env.AGENT_HUB_API_KEY).toBe('ahub_global_break_glass');
    expect(env.AGENT_HUB_AUTOPILOT_RUN_ID).toBeUndefined();
  });

  it('refuses to spawn a bound Autopilot worker after the run token is revoked', () => {
    writeAutopilotWorkerToken('run-1', 'ahub_scoped_worker', dataDir);
    bindAutopilotWorkerSession('sess-worker', { projectId: 'demo-app', runId: 'run-1' }, dataDir);
    removeAutopilotWorkerToken('run-1', dataDir);

    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg,
        ownerId: userId,
        credsOwnerId: userId,
        sessionId: 'sess-worker',
        engine: 'gemini-cli',
      }),
    ).toThrow(AutopilotWorkerCredentialError);

    const unbound = resolveSessionCliSpawnEnv({
      cfg,
      ownerId: userId,
      credsOwnerId: userId,
      sessionId: 'sess-unrelated',
      engine: 'gemini-cli',
    });
    expect(unbound.AGENT_HUB_API_KEY).toBe('ahub_global_break_glass');
  });

  it('refuses to spawn when a binding file is empty, malformed, or incomplete', () => {
    const filePath = autopilotSessionBindingPath('sess-broken', dataDir);
    mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });

    writeFileSync(filePath, '   ');
    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg,
        ownerId: userId,
        credsOwnerId: userId,
        sessionId: 'sess-broken',
        engine: 'gemini-cli',
      }),
    ).toThrow(AutopilotWorkerCredentialError);

    writeFileSync(filePath, '{');
    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg,
        ownerId: userId,
        credsOwnerId: userId,
        sessionId: 'sess-broken',
        engine: 'gemini-cli',
      }),
    ).toThrow(AutopilotWorkerCredentialError);

    writeFileSync(filePath, JSON.stringify({ projectId: 'demo-app', runId: '' }));
    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg,
        ownerId: userId,
        credsOwnerId: userId,
        sessionId: 'sess-broken',
        engine: 'gemini-cli',
      }),
    ).toThrow(AutopilotWorkerCredentialError);
  });
});
