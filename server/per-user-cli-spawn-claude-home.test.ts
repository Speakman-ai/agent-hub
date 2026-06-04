/**
 * Per-account auth + per-user HOME selection in `resolveSessionCliSpawnEnv`.
 *
 * Auth is strictly per-account: there is no host or org-owner fallback. A
 * spawn for a per-account engine (claude-code / cursor-agent / codex-cli)
 * hard-fails with `EngineAuthRequiredError` when the acting user has no
 * credentials for that specific engine. When the user DOES have creds, HOME
 * is pinned to their per-user tree so each engine's CLI cache (`.cursor`,
 * `.codex`, `.claude`, Gemini OAuth) stays isolated under their subtree.
 *
 * This guards against the prior behavior where a reviewer / NULL-owner spawn
 * silently borrowed the operator's host CLI HOME (and thus the operator's
 * Claude/Cursor/Codex login).
 */
import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveSessionCliSpawnEnv, EngineAuthRequiredError } from './per-user-cli-spawn.js';
import { perUserHomePath } from './per-user-home.js';
import { perUserCliHomePath } from './per-user-cli-home.js';
import { initOrgsDb, setOrgsDbPathForTests } from './orgs.js';
import { createUser, setUserClaudeAuth } from './users-store.js';
import type { AppConfig } from './types.js';

function makeCfg(dataDir: string): AppConfig {
  // Minimal AppConfig shape — buildSpawnEnv only reads a handful of fields
  // and the test-setup CLI guard already points the binary paths at the
  // no-real-CLI shim. Casting through unknown keeps the test resilient if
  // AppConfig grows new fields the spawn pipeline doesn't read.
  return {
    dataDir,
    apiKey: '',
    geminiApiKey: null,
  } as unknown as AppConfig;
}

/** Seed a per-user Codex device-auth so the user has a Codex (only) identity. */
function seedPerUserCodexDeviceAuth(userId: string, dataDir: string): void {
  const codexHome = perUserCliHomePath('codex', userId, dataDir);
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(codexHome, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'fake-access', id_token: 'fake-id' },
    }),
    { mode: 0o600 },
  );
}

/** Seed a per-user `.claude/.credentials.json` so the Claude-identity check returns true. */
function seedPerUserClaudeCredentialsFile(userId: string, dataDir: string): void {
  const claudeDir = path.join(perUserHomePath(userId, dataDir), '.claude');
  mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(claudeDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { expiresAt: Date.now() + 86400_000 } }),
    { mode: 0o600 },
  );
}

/** Seed a non-empty per-user `.cursor` cache so the Cursor-identity check returns true. */
function seedPerUserCursorCache(userId: string, dataDir: string): void {
  const cursorDir = path.join(perUserHomePath(userId, dataDir), '.cursor');
  mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(cursorDir, 'auth.json'), JSON.stringify({ token: 'fake' }), {
    mode: 0o600,
  });
}

describe('resolveSessionCliSpawnEnv — per-account auth + per-user HOME', () => {
  let tmpDataDir: string;
  let isolatedHostHome: string;
  let prevHome: string | undefined;
  let orgsDbDir: string;
  let ownerId: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-'));
    isolatedHostHome = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-host-'));
    prevHome = process.env.HOME;
    process.env.HOME = isolatedHostHome;

    // Fresh orgs.db so each test starts from a clean user table.
    orgsDbDir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDbDir, 'orgs.db'));
    initOrgsDb();
    ownerId = createUser({
      username: `claude-home-owner-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it('claude-code spawn hard-fails when the acting user has only per-user Codex (no Claude creds)', () => {
    // The exact production setup that produced "Not logged in" reports — but
    // there is no host-HOME fallback anymore. The user completed Codex device
    // login but never set up Claude, so a claude-code spawn must hard-fail
    // rather than borrow the operator's host login.
    seedPerUserCodexDeviceAuth(ownerId, tmpDataDir);

    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg: makeCfg(tmpDataDir),
        ownerId: null,
        credsOwnerId: ownerId,
        engine: 'claude-code',
      }),
    ).toThrow(EngineAuthRequiredError);
  });

  it('claude-code spawn hard-fails when there is no acting user at all', () => {
    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg: makeCfg(tmpDataDir),
        ownerId: null,
        credsOwnerId: null,
        engine: 'claude-code',
      }),
    ).toThrow(EngineAuthRequiredError);
  });

  it('claude-code spawn pins per-user HOME when the user has a per-user .claude/.credentials.json', () => {
    seedPerUserClaudeCredentialsFile(ownerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: ownerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(perUserHomePath(ownerId, tmpDataDir));
  });

  it('claude-code spawn pins per-user HOME + injects token when the user has a Claude DB token', () => {
    setUserClaudeAuth(ownerId, {
      claudeCodeOAuthToken: 'sk-ant-oat01-user-token',
    });

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: ownerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(perUserHomePath(ownerId, tmpDataDir));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user-token');
  });

  it('cursor-agent spawn hard-fails when the user has only Codex (no Cursor creds)', () => {
    seedPerUserCodexDeviceAuth(ownerId, tmpDataDir);

    expect(() =>
      resolveSessionCliSpawnEnv({
        cfg: makeCfg(tmpDataDir),
        ownerId: null,
        credsOwnerId: ownerId,
        engine: 'cursor-agent',
      }),
    ).toThrow(EngineAuthRequiredError);
  });

  it('cursor-agent spawn pins per-user HOME when the user has a per-user Cursor cache', () => {
    seedPerUserCursorCache(ownerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: ownerId,
      engine: 'cursor-agent',
    });

    expect(env.HOME).toBe(perUserHomePath(ownerId, tmpDataDir));
  });

  it('omitting engine skips the per-account guard and pins per-user HOME (Cursor create-chat probe)', () => {
    // Some callers don't know the engine yet (e.g. the Cursor session
    // create-chat probe). They skip the guard and still get the per-user
    // HOME pin so per-engine caches stay isolated.
    seedPerUserCodexDeviceAuth(ownerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: ownerId,
      // engine: undefined
    });

    expect(env.HOME).toBe(perUserHomePath(ownerId, tmpDataDir));
  });
});
