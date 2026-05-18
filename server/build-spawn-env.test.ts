import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import config, { buildSpawnEnv, normalizeClaudeSetupToken, refreshShellPath } from './config.js';
import { mergeAllowlistedExtraEnv } from './extra-env-allowlist.js';
import { perUserHomePath } from './per-user-home.js';
import { perUserCliHomePath } from './per-user-cli-home.js';

describe('buildSpawnEnv — PATH propagation', () => {
  beforeEach(() => {
    refreshShellPath();
  });

  it('sets PATH on the spawn env', () => {
    const env = buildSpawnEnv();
    expect(env.PATH).toBeTruthy();
    expect(typeof env.PATH).toBe('string');
  });

  it('spawn env PATH is a superset of process.env.PATH entries', () => {
    const env = buildSpawnEnv();
    const spawned = new Set((env.PATH as string).split(':'));
    for (const seg of (process.env.PATH ?? '').split(':').filter(Boolean)) {
      expect(spawned.has(seg)).toBe(true);
    }
  });

  it('includes /usr/local/bin and /usr/bin so aws/gh are always reachable', () => {
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(':');
    expect(segs).toContain('/usr/local/bin');
    expect(segs).toContain('/usr/bin');
  });

  it('does not duplicate PATH entries after merge', () => {
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(':');
    const unique = new Set(segs);
    expect(segs.length).toBe(unique.size);
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN when config includes setup-token value', () => {
    const env = buildSpawnEnv({
      ...config,
      claudeCodeOAuthToken: 'sk-ant-oat01-test-token',
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
  });

  it('collapses interior whitespace/newlines in setup-token (wrapped terminal paste)', () => {
    const raw = 'sk-ant-oat01-partOne\npartTwo';
    expect(normalizeClaudeSetupToken(raw)).toBe('sk-ant-oat01-partOnepartTwo');
    const env = buildSpawnEnv({
      ...config,
      claudeCodeOAuthToken: raw,
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-partOnepartTwo');
  });

  it('does not pass ANTHROPIC_API_KEY when Hub config has no API key (avoids stale process.env)', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-leak';
    try {
      const env = buildSpawnEnv({
        ...config,
        anthropicApiKey: null,
      });
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('buildSpawnEnv — per-user override (per-user Claude auth)', () => {
  it('user override wins over host config for ANTHROPIC_API_KEY', () => {
    const env = buildSpawnEnv(
      { ...config, anthropicApiKey: 'sk-ant-api03-host', claudeCodeOAuthToken: null },
      { userOverride: { anthropicApiKey: 'sk-ant-api03-user', claudeCodeOAuthToken: null } },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-user');
  });

  it('user override wins over host config for CLAUDE_CODE_OAUTH_TOKEN', () => {
    const env = buildSpawnEnv(
      { ...config, anthropicApiKey: null, claudeCodeOAuthToken: 'sk-ant-oat01-host' },
      { userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: 'sk-ant-oat01-user' } },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user');
  });

  it('falls back to host config when only one user field is set (independent fields)', () => {
    // User has an OAuth token but no API key — host's API key should still
    // be ignored only for the field the user supplied. The other field
    // falls back to the host. With no host API key + user OAuth-only, the
    // host's OAuth must NOT leak past the user's empty API key choice.
    const env = buildSpawnEnv(
      {
        ...config,
        anthropicApiKey: 'sk-ant-api03-host',
        claudeCodeOAuthToken: 'sk-ant-oat01-host',
      },
      { userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: 'sk-ant-oat01-user' } },
    );
    // User did not override the API key → host wins for that field.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-host');
    // User overrode the OAuth token → user wins.
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user');
  });

  it('whitespace-only override is treated as not provided (falls back to host)', () => {
    const env = buildSpawnEnv(
      { ...config, anthropicApiKey: 'sk-ant-api03-host', claudeCodeOAuthToken: null },
      { userOverride: { anthropicApiKey: '   ', claudeCodeOAuthToken: null } },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-host');
  });

  it('omitted userOverride preserves legacy behavior', () => {
    const env = buildSpawnEnv({
      ...config,
      anthropicApiKey: 'sk-ant-api03-host',
      claudeCodeOAuthToken: 'sk-ant-oat01-host',
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-host');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-host');
  });

  it('null userOverride is equivalent to omitted', () => {
    const env = buildSpawnEnv(
      { ...config, anthropicApiKey: 'sk-ant-api03-host', claudeCodeOAuthToken: null },
      { userOverride: null },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-host');
  });

  it('normalizes wrapped user OAuth tokens (interior whitespace collapsed)', () => {
    const env = buildSpawnEnv(
      { ...config, claudeCodeOAuthToken: null },
      { userOverride: { claudeCodeOAuthToken: 'sk-ant-oat01-userPart\n1userPart2' } },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-userPart1userPart2');
  });

  it('with no host config and no user override, both vars are unset', () => {
    const prevApi = process.env.ANTHROPIC_API_KEY;
    const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-leaked';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-leaked';
    try {
      const env = buildSpawnEnv(
        { ...config, anthropicApiKey: null, claudeCodeOAuthToken: null },
        { userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: null } },
      );
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    } finally {
      if (prevApi === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prevApi;
      if (prevOAuth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = prevOAuth;
    }
  });
});

describe('buildSpawnEnv — per-user Cursor / Gemini / Codex override', () => {
  it('user CURSOR_API_KEY wins over host config', () => {
    const env = buildSpawnEnv(
      { ...config, cursorApiKey: 'curs-host' },
      { userOverride: { cursorApiKey: 'curs-user' } },
    );
    expect(env.CURSOR_API_KEY).toBe('curs-user');
  });

  it('user GEMINI_API_KEY wins over host config', () => {
    const env = buildSpawnEnv(
      { ...config, geminiApiKey: 'gem-host' },
      { userOverride: { geminiApiKey: 'gem-user' } },
    );
    expect(env.GEMINI_API_KEY).toBe('gem-user');
  });

  it('user CODEX_API_KEY fans out to OPENAI_API_KEY + CODEX_API_KEY', () => {
    const env = buildSpawnEnv(
      { ...config, codexApiKey: 'sk-codex-host' },
      { userOverride: { codexApiKey: 'sk-codex-user' } },
    );
    expect(env.CODEX_API_KEY).toBe('sk-codex-user');
    expect(env.OPENAI_API_KEY).toBe('sk-codex-user');
  });

  it('per-engine fields are independent — Cursor override does not affect Gemini/Codex', () => {
    const env = buildSpawnEnv(
      {
        ...config,
        cursorApiKey: 'curs-host',
        geminiApiKey: 'gem-host',
        codexApiKey: 'sk-codex-host',
      },
      { userOverride: { cursorApiKey: 'curs-user' } },
    );
    expect(env.CURSOR_API_KEY).toBe('curs-user');
    expect(env.GEMINI_API_KEY).toBe('gem-host');
    expect(env.CODEX_API_KEY).toBe('sk-codex-host');
    expect(env.OPENAI_API_KEY).toBe('sk-codex-host');
  });

  it('whitespace-only override is treated as not provided per engine', () => {
    const env = buildSpawnEnv(
      { ...config, cursorApiKey: 'curs-host', geminiApiKey: 'gem-host', codexApiKey: 'codex-host' },
      { userOverride: { cursorApiKey: '  ', geminiApiKey: '\t', codexApiKey: '' } },
    );
    expect(env.CURSOR_API_KEY).toBe('curs-host');
    expect(env.GEMINI_API_KEY).toBe('gem-host');
    expect(env.CODEX_API_KEY).toBe('codex-host');
  });

  it('with no host config and no user override, all three engine vars are unset', () => {
    const prevCursor = process.env.CURSOR_API_KEY;
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevCodex = process.env.CODEX_API_KEY;
    const prevOpenai = process.env.OPENAI_API_KEY;
    process.env.CURSOR_API_KEY = 'leaked-cursor';
    process.env.GEMINI_API_KEY = 'leaked-gemini';
    process.env.CODEX_API_KEY = 'leaked-codex';
    process.env.OPENAI_API_KEY = 'leaked-openai';
    try {
      const env = buildSpawnEnv(
        { ...config, cursorApiKey: null, geminiApiKey: null, codexApiKey: null },
        { userOverride: { cursorApiKey: null, geminiApiKey: null, codexApiKey: null } },
      );
      expect(env.CURSOR_API_KEY).toBeUndefined();
      expect(env.GEMINI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.OPENAI_API_KEY).toBeUndefined();
    } finally {
      if (prevCursor === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prevCursor;
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
      if (prevCodex === undefined) delete process.env.CODEX_API_KEY;
      else process.env.CODEX_API_KEY = prevCodex;
      if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpenai;
    }
  });

  it('host config flows through when no override is set', () => {
    const env = buildSpawnEnv({
      ...config,
      cursorApiKey: 'curs-host-only',
      geminiApiKey: 'gem-host-only',
      codexApiKey: 'codex-host-only',
    });
    expect(env.CURSOR_API_KEY).toBe('curs-host-only');
    expect(env.GEMINI_API_KEY).toBe('gem-host-only');
    expect(env.CODEX_API_KEY).toBe('codex-host-only');
    expect(env.OPENAI_API_KEY).toBe('codex-host-only');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extraEnv gate — uses production `mergeAllowlistedExtraEnv` from
// `extra-env-allowlist.ts` (same path as `chat.ts`).
// ─────────────────────────────────────────────────────────────────────────────

describe('mergeAllowlistedExtraEnv — spawn env integration', () => {
  it('allowlisted key (DEV_HUB_API_KEY) is accepted when spawnEnv does not have it', () => {
    const spawnEnv = { PATH: '/usr/bin' } as NodeJS.ProcessEnv;
    mergeAllowlistedExtraEnv(spawnEnv, { DEV_HUB_API_KEY: 'ahub_key' });
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('ahub_key');
    expect(spawnEnv.PATH).toBe('/usr/bin');
  });

  it('allowlisted key is silently dropped when spawnEnv already has it', () => {
    const spawnEnv = { DEV_HUB_API_KEY: 'server-set' } as NodeJS.ProcessEnv;
    mergeAllowlistedExtraEnv(spawnEnv, { DEV_HUB_API_KEY: 'caller-override' });
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('server-set');
  });

  it('non-allowlisted GH_TOKEN is silently dropped — cannot shadow server auth', () => {
    const spawnEnv = { GH_TOKEN: 'server-token' } as NodeJS.ProcessEnv;
    mergeAllowlistedExtraEnv(spawnEnv, { GH_TOKEN: 'caller-token' });
    expect(spawnEnv.GH_TOKEN).toBe('server-token');
  });

  it('non-allowlisted ANTHROPIC_API_KEY is dropped even when absent from spawnEnv', () => {
    const spawnEnv = {} as NodeJS.ProcessEnv;
    mergeAllowlistedExtraEnv(spawnEnv, { ANTHROPIC_API_KEY: 'sk-ant-caller' });
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AGENT_HUB_API_KEY + AGENT_HUB_DATA_DIR injection — every spawn site
// (heartbeat, cron, delegation, room-chat, slack, design-chat, one-shot, …)
// goes through `buildSpawnEnv`, so config rotations propagate uniformly
// instead of only through the chat.ts spawn path. See server/spawn-creds-file.ts
// for the long-running-chat recovery path that complements this.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSpawnEnv — AGENT_HUB_API_KEY injection', () => {
  it('injects AGENT_HUB_API_KEY from cfg.apiKey when present', () => {
    const env = buildSpawnEnv({ ...config, apiKey: 'cfg-key-after-setup' });
    expect(env.AGENT_HUB_API_KEY).toBe('cfg-key-after-setup');
  });

  it('deletes AGENT_HUB_API_KEY when cfg.apiKey is null (avoids stale process.env leak)', () => {
    const prev = process.env.AGENT_HUB_API_KEY;
    process.env.AGENT_HUB_API_KEY = 'stale-from-server-start';
    try {
      const env = buildSpawnEnv({ ...config, apiKey: null });
      expect(env.AGENT_HUB_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AGENT_HUB_API_KEY;
      else process.env.AGENT_HUB_API_KEY = prev;
    }
  });

  it('cfg.apiKey wins over a stale process.env.AGENT_HUB_API_KEY', () => {
    // Simulates: server started with one key in the env, operator rotated the
    // key in config.json and called the wrappers fresh. The fresh value must
    // win — otherwise heartbeats/crons would keep using the original.
    const prev = process.env.AGENT_HUB_API_KEY;
    process.env.AGENT_HUB_API_KEY = 'old-key-at-server-start';
    try {
      const env = buildSpawnEnv({ ...config, apiKey: 'new-rotated-key' });
      expect(env.AGENT_HUB_API_KEY).toBe('new-rotated-key');
    } finally {
      if (prev === undefined) delete process.env.AGENT_HUB_API_KEY;
      else process.env.AGENT_HUB_API_KEY = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Per-user HOME pin — Cursor/Codex/Gemini CLI caches under `.cursor`,
// `.codex`, etc. are isolated per Hub user when the spawn carries a
// userId. See server/per-user-home.ts for the directory contract and
// the "Per-user browser-button auth for Cursor & Codex" card.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSpawnEnv — per-user HOME pin', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-perusrhome-'));
  });

  it('preserves the host HOME when no userId is supplied (legacy global-apiKey path)', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir });
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('redirects HOME to <dataDir>/per-user-creds/<userId>/home when userId is set', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'user-abc' });
    expect(env.HOME).toBe(perUserHomePath('user-abc', tmpDataDir));
    expect(env.HOME).toMatch(/\/per-user-creds\/user-abc\/home$/);
  });

  it('creates the per-user HOME directory tree on demand', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'user-create' });
    expect(existsSync(env.HOME as string)).toBe(true);
  });

  it('per-user HOME is created with mode 0700 (no other user can read CLI tokens)', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'user-perms' });
    const mode = statSync(env.HOME as string).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('treats whitespace-only userId as "not provided" (falls back to host HOME)', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: '   ' });
    expect(env.HOME).toBe(process.env.HOME);
  });

  it('different userIds get different HOME paths', () => {
    const envA = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'user-A' });
    const envB = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'user-B' });
    expect(envA.HOME).not.toBe(envB.HOME);
    expect(envA.HOME).toMatch(/user-A\/home$/);
    expect(envB.HOME).toMatch(/user-B\/home$/);
  });

  it('rejects userId containing path-traversal segments by falling back to host HOME', () => {
    // The per-user-home module throws on bad ids; buildSpawnEnv swallows the
    // throw so a malformed id can never block a spawn.
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: '../escape' });
    expect(env.HOME).toBe(process.env.HOME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 — Per-user CODEX_HOME injection. When a user has completed a per-user
// device login via POST /api/auth/me/codex-auth/login, an auth.json lands in
// <dataDir>/per-user-cli-home/codex/<userId>. Subsequent spawns owned by that
// user must point the codex CLI at the same path via CODEX_HOME — otherwise
// codex falls back to ~/.codex (the per-user HOME's .codex, which is empty)
// and re-prompts for login.
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSpawnEnv — per-user CODEX_HOME injection (P4)', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-codex-home-'));
  });

  function seedCodexAuth(userId: string, mode: 'chatgpt' | 'apikey'): string {
    const codexHome = perUserCliHomePath('codex', userId, tmpDataDir);
    mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const auth =
      mode === 'chatgpt'
        ? { auth_mode: 'chatgpt', tokens: { access_token: 'x', id_token: 'y' } }
        : { auth_mode: 'apikey', OPENAI_API_KEY: 'sk-codex-from-cli' };
    writeFileSync(path.join(codexHome, 'auth.json'), JSON.stringify(auth));
    return codexHome;
  }

  it('injects CODEX_HOME when user has a chatgpt-mode auth.json under per-user-cli-home/codex/<uid>', () => {
    const userId = 'codex-chatgpt-user';
    const expected = seedCodexAuth(userId, 'chatgpt');
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId });
    expect(env.CODEX_HOME).toBe(expected);
  });

  it('injects CODEX_HOME when the per-user CLI cache uses apikey mode', () => {
    const userId = 'codex-apikey-user';
    const expected = seedCodexAuth(userId, 'apikey');
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId });
    expect(env.CODEX_HOME).toBe(expected);
  });

  it('does NOT inject CODEX_HOME when the per-user dir is missing entirely', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'codex-no-login-yet' });
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('does NOT inject CODEX_HOME when the per-user dir exists but auth.json is missing', () => {
    // An aborted login leaves an empty CODEX_HOME tree behind; treat that
    // as "no login" so codex falls back to the per-user HOME's .codex
    // instead of pointing at an empty dir.
    const userId = 'codex-aborted-login';
    const home = perUserCliHomePath('codex', userId, tmpDataDir);
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId });
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('does NOT inject CODEX_HOME when no userId is supplied (legacy global-apiKey path)', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir });
    expect(env.CODEX_HOME).toBeUndefined();
  });

  it('drops a stale process.env.CODEX_HOME for a per-user spawn with no per-user login', () => {
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = '/leaked/host/codex/home';
    try {
      const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'codex-leak-guard' });
      // Without a per-user login, the host-process CODEX_HOME must NOT
      // leak into the spawn — that would point the user's codex at the
      // operator's cache and silently sign them in as the wrong account.
      expect(env.CODEX_HOME).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });

  it('different users get different CODEX_HOME paths once both have logged in', () => {
    const homeA = seedCodexAuth('codex-A', 'chatgpt');
    const homeB = seedCodexAuth('codex-B', 'chatgpt');
    const envA = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'codex-A' });
    const envB = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: 'codex-B' });
    expect(envA.CODEX_HOME).toBe(homeA);
    expect(envB.CODEX_HOME).toBe(homeB);
    expect(envA.CODEX_HOME).not.toBe(envB.CODEX_HOME);
  });

  it('falls back gracefully (no CODEX_HOME) for a path-traversal userId', () => {
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: '../escape' });
    expect(env.CODEX_HOME).toBeUndefined();
  });
});

describe('buildSpawnEnv — AGENT_HUB_DATA_DIR injection', () => {
  it('exports AGENT_HUB_DATA_DIR from cfg.dataDir', () => {
    const env = buildSpawnEnv({ ...config, dataDir: '/tmp/test-data-dir' });
    expect(env.AGENT_HUB_DATA_DIR).toBe('/tmp/test-data-dir');
  });

  it('cfg.dataDir wins over process.env.AGENT_HUB_DATA_DIR', () => {
    // The spawn-creds file fallback in `ah-api.sh` reads
    // `$AGENT_HUB_DATA_DIR/spawn-creds/<sessionId>.token`. If the spawned
    // process inherited a different value from the server's start-time env,
    // the wrappers would look in the wrong directory and miss the recovery
    // file written by /api/auth/setup.
    const prev = process.env.AGENT_HUB_DATA_DIR;
    process.env.AGENT_HUB_DATA_DIR = '/tmp/stale-dir';
    try {
      const env = buildSpawnEnv({ ...config, dataDir: '/tmp/fresh-dir' });
      expect(env.AGENT_HUB_DATA_DIR).toBe('/tmp/fresh-dir');
    } finally {
      if (prev === undefined) delete process.env.AGENT_HUB_DATA_DIR;
      else process.env.AGENT_HUB_DATA_DIR = prev;
    }
  });
});
