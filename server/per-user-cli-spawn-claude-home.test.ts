/**
 * Engine-aware HOME selection in `resolveSessionCliSpawnEnv`.
 *
 * Background — the bug this regression-tests guards against:
 *
 * Reviewer sessions are persisted with `owner_user_id = NULL` so they're
 * shared/read-only across the org. `chat.ts` runs that NULL through
 * `resolveSpawnCredsOwnerUserId`, which falls back to the org owner. The
 * spawn pipeline then asked `userHasPerUserCliIdentity(orgOwner)` — true
 * for ANY engine — and pinned HOME to `<dataDir>/per-user-creds/<orgOwner>
 * /home`. That HOME tree has no `.claude/.credentials.json` (the operator
 * browser flow `POST /api/config/claude-auth/login` writes to
 * `<dataDir>/host-creds/home/.claude/.credentials.json` instead), so a
 * reviewer Claude spawn whose org owner had only set up Codex device-login
 * never saw the working host login and printed
 * `Not logged in · Please run /login`.
 *
 * The fix is engine-aware: when `engine === 'claude-code'` AND the user
 * has no Claude-specific identity (DB column OR per-user `.credentials.
 * json`), `resolveSessionCliSpawnEnv` drops the per-user HOME pin so the
 * spawn falls back to the persistent host CLI HOME. Other engines retain
 * the legacy any-identity-wins behavior; Cursor / Codex / Gemini have
 * their own per-user file caches that the per-user HOME branch already
 * routes to correctly.
 */
import './test/setup.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { resolveSessionCliSpawnEnv } from './per-user-cli-spawn.js';
import { hostCliHomePath } from './host-cli-home.js';
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
    anthropicApiKey: null,
    claudeCodeOAuthToken: null,
    cursorApiKey: null,
    geminiApiKey: null,
    codexApiKey: null,
  } as unknown as AppConfig;
}

/** Seed a per-user Codex device-auth so `userHasPerUserCliIdentity` returns true. */
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

describe('resolveSessionCliSpawnEnv — engine-aware HOME for claude-code', () => {
  let tmpDataDir: string;
  let isolatedHostHome: string;
  let prevHome: string | undefined;
  let orgsDbDir: string;
  let orgOwnerId: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-'));
    isolatedHostHome = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-host-'));
    prevHome = process.env.HOME;
    process.env.HOME = isolatedHostHome;

    // Fresh orgs.db so each test starts from a clean user table.
    orgsDbDir = mkdtempSync(path.join(os.tmpdir(), 'claude-home-test-orgs-'));
    setOrgsDbPathForTests(path.join(orgsDbDir, 'orgs.db'));
    initOrgsDb();
    orgOwnerId = createUser({
      username: `claude-home-org-owner-${Date.now()}-${Math.random()}`,
      passwordHash: 'h',
    }).id;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });

  it('reviewer-style claude-code spawn falls back to host CLI HOME when org owner has only per-user Codex', () => {
    // The exact production setup that produced "Not logged in" reports:
    // the org owner completed Codex device login (so any-identity-wins
    // returned true), but never pasted a per-user Claude token. Today's
    // operator-side fix is the `POST /api/config/claude-auth/login`
    // browser flow which writes `.claude/.credentials.json` into the
    // persistent host CLI HOME — that's the file the reviewer spawn must
    // see, and the per-user HOME pin used to shadow it.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: orgOwnerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(hostCliHomePath(tmpDataDir));
    expect(env.HOME).not.toBe(perUserHomePath(orgOwnerId, tmpDataDir));
  });

  it('claude-code spawn keeps per-user HOME when org owner has a per-user .claude/.credentials.json', () => {
    // File-based per-user Claude auth (e.g. a future per-user
    // `claude login` flow) — the per-user HOME pin must be preserved so
    // the spawn reads the user's own credentials.json, not the operator's.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);
    seedPerUserClaudeCredentialsFile(orgOwnerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: orgOwnerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(perUserHomePath(orgOwnerId, tmpDataDir));
  });

  it('claude-code spawn keeps per-user HOME when org owner has a per-user Claude DB token', () => {
    // DB-column-based per-user Claude auth: the env-token path injects
    // CLAUDE_CODE_OAUTH_TOKEN, but HOME also stays per-user so any
    // future per-user `.claude/` artifacts (MCP config, settings.json,
    // history) accumulate in the user's own tree rather than the
    // operator's.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);
    setUserClaudeAuth(orgOwnerId, {
      claudeCodeOAuthToken: 'sk-ant-oat01-user-token',
    });

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: orgOwnerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(perUserHomePath(orgOwnerId, tmpDataDir));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user-token');
  });

  it('cursor-agent spawn is unaffected — per-user HOME wins on any per-user identity (regression guard)', () => {
    // The fix is intentionally narrow: only claude-code routes around the
    // per-user HOME pin. Cursor / Codex / Gemini have file caches that
    // live under the per-user HOME, so the legacy behavior is correct
    // for them.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: orgOwnerId,
      engine: 'cursor-agent',
    });

    expect(env.HOME).toBe(perUserHomePath(orgOwnerId, tmpDataDir));
  });

  it('claude-code spawn for a regular session owner with no per-user Claude also falls back to host HOME', () => {
    // Not just reviewers: any session whose creds-owner lacks per-user
    // Claude benefits from the host-HOME fallback. The env-token chain
    // (per-user override → host config) still bills the same level it
    // did before, so this is strictly additive — when both per-user and
    // host config Claude tokens are unset, the spawn now reads the
    // host-creds `.credentials.json` instead of hard-failing.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: orgOwnerId, // real session owner, not a reviewer NULL
      credsOwnerId: orgOwnerId,
      engine: 'claude-code',
    });

    expect(env.HOME).toBe(hostCliHomePath(tmpDataDir));
  });

  it('omitting engine preserves legacy any-identity-wins behavior for non-Claude callers', () => {
    // Some callers don't know the engine yet (e.g. Cursor session
    // create-chat probe). They must continue to get the per-user HOME
    // pin on any per-user identity so per-engine caches stay isolated.
    seedPerUserCodexDeviceAuth(orgOwnerId, tmpDataDir);

    const env = resolveSessionCliSpawnEnv({
      cfg: makeCfg(tmpDataDir),
      ownerId: null,
      credsOwnerId: orgOwnerId,
      // engine: undefined
    });

    expect(env.HOME).toBe(perUserHomePath(orgOwnerId, tmpDataDir));
  });
});
