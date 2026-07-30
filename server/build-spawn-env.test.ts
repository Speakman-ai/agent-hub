import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, statSync, writeFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import config, {
  applyEngineScopedSpawnEnv,
  buildSpawnEnv,
  normalizeClaudeSetupToken,
  refreshShellPath,
  resolveSkillsDir,
  resolveSkillScriptsDirs,
} from './config.js';
import { mergeAllowlistedExtraEnv } from './extra-env-allowlist.js';
import { perUserHomePath } from './per-user-home.js';
import { perUserCliHomePath } from './per-user-cli-home.js';
import { hostCliHomePath } from './host-cli-home.js';

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

  it('sets CLAUDE_CODE_OAUTH_TOKEN from a per-user override setup-token value', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { claudeCodeOAuthToken: 'sk-ant-oat01-test-token' },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-test-token');
  });

  it('collapses interior whitespace/newlines in setup-token (wrapped terminal paste)', () => {
    const raw = 'sk-ant-oat01-partOne\npartTwo';
    expect(normalizeClaudeSetupToken(raw)).toBe('sk-ant-oat01-partOnepartTwo');
    const env = buildSpawnEnv(config, {
      userOverride: { claudeCodeOAuthToken: raw },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-partOnepartTwo');
  });

  it('does not pass ANTHROPIC_API_KEY when there is no per-user override (avoids stale process.env)', () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-should-not-leak';
    try {
      const env = buildSpawnEnv(config);
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe('buildSpawnEnv — per-user Claude credentials (per-account only, no host fallback)', () => {
  it('per-user override sets ANTHROPIC_API_KEY', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { anthropicApiKey: 'sk-ant-api03-user', claudeCodeOAuthToken: null },
    });
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-user');
  });

  it('per-user override sets CLAUDE_CODE_OAUTH_TOKEN', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: 'sk-ant-oat01-user' },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user');
  });

  it('the two Claude fields are independent', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: 'sk-ant-oat01-user' },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-user');
  });

  it('whitespace-only override is treated as not provided (no key set)', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { anthropicApiKey: '   ', claudeCodeOAuthToken: null },
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('omitted userOverride sets neither Claude var (no host fallback)', () => {
    const env = buildSpawnEnv(config);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('null userOverride sets neither Claude var', () => {
    const env = buildSpawnEnv(config, { userOverride: null });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('normalizes wrapped user OAuth tokens (interior whitespace collapsed)', () => {
    const env = buildSpawnEnv(config, {
      userOverride: { claudeCodeOAuthToken: 'sk-ant-oat01-userPart\n1userPart2' },
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-userPart1userPart2');
  });

  it('with no per-user override, Claude vars are unset even when process.env carries them', () => {
    const prevApi = process.env.ANTHROPIC_API_KEY;
    const prevOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-leaked';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-leaked';
    try {
      const env = buildSpawnEnv(config, {
        userOverride: { anthropicApiKey: null, claudeCodeOAuthToken: null },
      });
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

describe('buildSpawnEnv — per-user Cursor / Codex (per-account) + global Gemini', () => {
  let tmpDataDir: string;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-spawn-keys-'));
  });

  it('per-user override sets CURSOR_API_KEY', () => {
    const env = buildSpawnEnv(config, { userOverride: { cursorApiKey: 'curs-user' } });
    expect(env.CURSOR_API_KEY).toBe('curs-user');
  });

  it('user GEMINI_API_KEY wins over host config (Gemini stays global)', () => {
    const env = buildSpawnEnv(
      { ...config, geminiApiKey: 'gem-host' },
      { userOverride: { geminiApiKey: 'gem-user' } },
    );
    expect(env.GEMINI_API_KEY).toBe('gem-user');
  });

  it('host GEMINI_API_KEY flows through when no override (Gemini is the one global engine)', () => {
    const env = buildSpawnEnv({ ...config, geminiApiKey: 'gem-host-only' });
    expect(env.GEMINI_API_KEY).toBe('gem-host-only');
  });

  it('always sets GEMINI_CLI_TRUST_WORKSPACE=true so headless Gemini spawns clear the trusted-folder gate', () => {
    // Regression: recent Gemini CLI versions refuse to run with
    // "Gemini CLI is not running in a trusted directory" in non-interactive
    // spawns (crons/heartbeats fired twice daily). The env var must be set
    // regardless of whether a Gemini key is configured.
    const withKey = buildSpawnEnv({ ...config, geminiApiKey: 'gem-host' });
    expect(withKey.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');

    const prevGemini = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const noKey = buildSpawnEnv({ ...config, geminiApiKey: null });
      expect(noKey.GEMINI_API_KEY).toBeUndefined();
      expect(noKey.GEMINI_CLI_TRUST_WORKSPACE).toBe('true');
    } finally {
      if (prevGemini === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = prevGemini;
    }
  });

  it('user CODEX_API_KEY fans out to OPENAI_API_KEY + CODEX_API_KEY', () => {
    const env = buildSpawnEnv(config, { userOverride: { codexApiKey: 'sk-codex-user' } });
    expect(env.CODEX_API_KEY).toBe('sk-codex-user');
    expect(env.OPENAI_API_KEY).toBe('sk-codex-user');
  });

  it('does not leak host XAI_API_KEY into non-Grok spawns', () => {
    const prevXai = process.env.XAI_API_KEY;
    process.env.XAI_API_KEY = 'xai-process-should-not-leak';
    try {
      const base = buildSpawnEnv({ ...config, xaiApiKey: 'xai-host' });
      const claude = buildSpawnEnv({ ...config, xaiApiKey: 'xai-host' }, { engine: 'claude-code' });
      const codex = buildSpawnEnv({ ...config, xaiApiKey: 'xai-host' }, { engine: 'codex-cli' });

      expect(base.XAI_API_KEY).toBeUndefined();
      expect(claude.XAI_API_KEY).toBeUndefined();
      expect(codex.XAI_API_KEY).toBeUndefined();
    } finally {
      if (prevXai === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = prevXai;
    }
  });

  it('does not inject host XAI_API_KEY into grok-cli spawns', () => {
    const env = buildSpawnEnv({ ...config, xaiApiKey: 'xai-host' }, { engine: 'grok-cli' });
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('injects the per-user grok key on grok-cli spawns', () => {
    const env = buildSpawnEnv(
      { ...config, xaiApiKey: 'xai-host' },
      { engine: 'grok-cli', userOverride: { grokApiKey: 'xai-user' } },
    );
    expect(env.XAI_API_KEY).toBe('xai-user');
  });

  it('does not fall back to the host xAI key when the user has no grok override', () => {
    const env = buildSpawnEnv(
      { ...config, xaiApiKey: 'xai-host' },
      { engine: 'grok-cli', userOverride: { cursorApiKey: 'curs-user' } },
    );
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('a per-user grok key still never leaks into a non-grok spawn', () => {
    const env = buildSpawnEnv(
      { ...config, xaiApiKey: 'xai-host' },
      { engine: 'codex-cli', userOverride: { grokApiKey: 'xai-user' } },
    );
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('applyEngineScopedSpawnEnv uses only the per-user override for grok-cli', () => {
    const env = applyEngineScopedSpawnEnv(
      {},
      { ...config, xaiApiKey: 'xai-host' },
      'grok-cli',
      'xai-user-override',
    );
    expect(env.XAI_API_KEY).toBe('xai-user-override');
  });

  it('applyEngineScopedSpawnEnv ignores host xAI key when no override is provided', () => {
    const env = applyEngineScopedSpawnEnv({}, { ...config, xaiApiKey: 'xai-host' }, 'grok-cli');
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('sanitizes direct helper callers before applying engine-scoped keys', () => {
    const env = applyEngineScopedSpawnEnv(
      { XAI_API_KEY: 'xai-existing-should-not-leak' },
      { ...config, xaiApiKey: 'xai-host' },
      'gemini-cli',
    );
    expect(env.XAI_API_KEY).toBeUndefined();
  });

  it('per-engine fields are independent — Cursor override does not affect Gemini/Codex', () => {
    const env = buildSpawnEnv(
      { ...config, geminiApiKey: 'gem-host' },
      { userOverride: { cursorApiKey: 'curs-user' } },
    );
    expect(env.CURSOR_API_KEY).toBe('curs-user');
    expect(env.GEMINI_API_KEY).toBe('gem-host');
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it('whitespace-only override is treated as not provided per engine', () => {
    const env = buildSpawnEnv(
      { ...config, geminiApiKey: 'gem-host' },
      { userOverride: { cursorApiKey: '  ', geminiApiKey: '\t', codexApiKey: '' } },
    );
    expect(env.CURSOR_API_KEY).toBeUndefined();
    // Gemini override is whitespace → falls back to the host (global) value.
    expect(env.GEMINI_API_KEY).toBe('gem-host');
    expect(env.CODEX_API_KEY).toBeUndefined();
  });

  it('with no host Gemini and no user override, all engine vars are unset', () => {
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
        { ...config, geminiApiKey: null },
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

  it('with userId set, Cursor/Codex are never host-injected; Gemini stays global', () => {
    const env = buildSpawnEnv(
      {
        ...config,
        dataDir: tmpDataDir,
        geminiApiKey: 'gem-host',
      },
      { userId: 'spawn-user-no-keys' },
    );
    expect(env.CURSOR_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    // Gemini is the one global engine — it still flows for any spawn.
    expect(env.GEMINI_API_KEY).toBe('gem-host');
  });

  it('with userId set, per-user override still wins for Cursor/Codex', () => {
    const env = buildSpawnEnv(
      {
        ...config,
        dataDir: tmpDataDir,
      },
      {
        userId: 'spawn-user-with-keys',
        userOverride: { cursorApiKey: 'curs-user', codexApiKey: 'sk-codex-user' },
      },
    );
    expect(env.CURSOR_API_KEY).toBe('curs-user');
    expect(env.CODEX_API_KEY).toBe('sk-codex-user');
    expect(env.OPENAI_API_KEY).toBe('sk-codex-user');
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
// (heartbeat, cron, room-chat, slack, design-chat, one-shot, …)
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
  let isolatedHostHome: string;
  let prevHome: string | undefined;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-perusrhome-'));
    // Pin process.env.HOME to a clean temp dir so the no-userId branch's
    // one-shot `ensureHostCliHome` migration does NOT recursively copy the
    // developer's real ~/.cursor / ~/.codex caches (potentially hundreds of
    // megabytes) into the test fixture. Without this guard, runners with a
    // populated home dir time out before the assertion executes. CI's clean
    // /home/runner happens to make this invisible, but it's a real
    // robustness issue worth fixing here.
    isolatedHostHome = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-hosthome-'));
    prevHome = process.env.HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = isolatedHostHome;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
  });

  it('pins HOME to the persistent host-creds tree when no userId is supplied (legacy global-apiKey path)', () => {
    // With no userId, the spawn no longer inherits the ephemeral host HOME.
    // Instead it points at `<dataDir>/host-creds/home` so operator Cursor /
    // Codex OAuth caches survive container restarts on Docker (where only
    // `/data` is persistent). See server/host-cli-home.ts for the migration
    // semantics.
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir });
    expect(env.HOME).toBe(hostCliHomePath(tmpDataDir));
    expect(env.HOME).toMatch(/\/host-creds\/home$/);
    expect(existsSync(env.HOME as string)).toBe(true);
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

  it('treats whitespace-only userId as "not provided" (falls back to persistent host HOME)', () => {
    // Whitespace-only userId follows the no-userId branch, so HOME pins to
    // the persistent host-creds tree just like the legacy global-apiKey
    // path. It must NOT leak the operator's ephemeral process.env.HOME.
    const env = buildSpawnEnv({ ...config, dataDir: tmpDataDir }, { userId: '   ' });
    expect(env.HOME).toBe(hostCliHomePath(tmpDataDir));
    expect(env.HOME).toMatch(/\/host-creds\/home$/);
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
    // throw so a malformed id can never block a spawn. Path-traversal is
    // non-empty after trim, so `presentString` treats it as a provided
    // userId — execution enters the per-user `if` branch, the catch
    // swallows the throw, and HOME is left at process.env.HOME (NOT the
    // host-creds tree, which is only reached when no userId is provided).
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
  let isolatedHostHome: string;
  let prevHome: string | undefined;
  let prevCodexHome: string | undefined;

  beforeEach(() => {
    tmpDataDir = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-codex-home-'));
    // Same HOME isolation as the per-user HOME pin block: a populated
    // developer ~/.cursor / ~/.codex would otherwise be recursively copied
    // into the test fixture during ensureHostCliHome's migration step.
    isolatedHostHome = mkdtempSync(path.join(os.tmpdir(), 'agent-hub-test-codex-hosthome-'));
    prevHome = process.env.HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = isolatedHostHome;
    delete process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
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

describe('buildSpawnEnv — agent-hub skill-script contract', () => {
  beforeEach(() => {
    refreshShellPath();
  });

  // The bundled agent-hub skill documents shell wrappers (board.sh,
  // wiki-search.sh, server.sh, …) that agents are told to run on first call.
  // These tests lock the contract that makes those commands resolvable from a
  // spawned session: an env var pointing at the skill root, and the scripts
  // dir on PATH so the wrappers are callable by bare name. Before this, the
  // scripts were neither on PATH nor pointed at by any env var, so the first
  // documented invocation failed and agents fell back to hand-rolled curl.

  it('exports AGENT_HUB_SKILLS_DIR pointing at the bundled skill on disk', () => {
    const skillsDir = resolveSkillsDir();
    expect(skillsDir).toBeTruthy(); // bundled skill must exist in the repo
    const env = buildSpawnEnv();
    expect(env.AGENT_HUB_SKILLS_DIR).toBe(skillsDir);
    expect(existsSync(env.AGENT_HUB_SKILLS_DIR as string)).toBe(true);
  });

  it('prepends the skill scripts dir to PATH', () => {
    const skillsDir = resolveSkillsDir() as string;
    const scriptsDir = path.join(skillsDir, 'scripts');
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(path.delimiter);
    expect(segs).toContain(scriptsDir);
    // Prepended, so the canonical wrappers win over same-named stragglers.
    expect(segs[0]).toBe(scriptsDir);
  });

  it('makes the documented wrappers resolvable by bare name on PATH', () => {
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(path.delimiter);
    // A representative set of wrappers the kanban / wiki / core skills tell
    // agents to invoke. Each must live in exactly one PATH dir and be
    // executable, or the documented happy-path breaks on first use.
    for (const name of ['board.sh', 'wiki-search.sh', 'server.sh', 'get-board-state.sh']) {
      const hit = segs
        .map((d) => path.join(d, name))
        .find((p) => existsSync(p) && (statSync(p).mode & 0o111) !== 0);
      expect(hit, `${name} must be resolvable + executable on the spawn PATH`).toBeTruthy();
    }
  });

  it('injects the scripts dir exactly once even if it was already on PATH', () => {
    const skillsDir = resolveSkillsDir() as string;
    const scriptsDir = path.join(skillsDir, 'scripts');
    // Seed the inherited PATH with the scripts dir so a naive prepend would
    // duplicate it. The prepend must dedupe (and not depend on the host PATH
    // being globally duplicate-free).
    const prevPath = process.env.PATH;
    process.env.PATH = `${scriptsDir}${path.delimiter}${prevPath ?? ''}`;
    try {
      const env = buildSpawnEnv();
      const segs = (env.PATH as string).split(path.delimiter);
      expect(segs.filter((s) => s === scriptsDir).length).toBe(1);
      expect(segs[0]).toBe(scriptsDir);
    } finally {
      if (prevPath === undefined) delete process.env.PATH;
      else process.env.PATH = prevPath;
    }
  });

  // Regression: the AWS/gcloud/github/google/1password domain skills each ship
  // their own scripts/ dir whose wrappers are documented as bare-name commands,
  // but only agent-hub/scripts was ever put on PATH — so `aws-whoami.sh` and
  // friends failed with "command not found" ("AWS login skill doesn't work").
  it('lists agent-hub scripts first, then every other default-skill scripts dir', () => {
    const dirs = resolveSkillScriptsDirs();
    const agentHubScripts = path.join(resolveSkillsDir() as string, 'scripts');
    expect(dirs[0]).toBe(agentHubScripts); // canonical wrappers win name ties
    // Every entry exists on disk and none is duplicated.
    for (const d of dirs) expect(existsSync(d)).toBe(true);
    expect(new Set(dirs).size).toBe(dirs.length);
    // Includes the domain skills that regressed, not just agent-hub.
    const names = dirs.map((d) => path.basename(path.dirname(d)));
    expect(names).toContain('aws-cli');
  });

  it('makes the AWS wrappers resolvable by bare name on the spawn PATH', () => {
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(path.delimiter);
    // The "Project AWS" section tells agents to call these by bare name; before
    // the fix neither lived on PATH and the AWS skill appeared broken.
    for (const name of ['aws-whoami.sh', 'aws-q.sh']) {
      const hit = segs
        .map((d) => path.join(d, name))
        .find((p) => existsSync(p) && (statSync(p).mode & 0o111) !== 0);
      expect(hit, `${name} must be resolvable + executable on the spawn PATH`).toBeTruthy();
    }
  });

  it('keeps every domain-skill wrapper resolvable, not just agent-hub', () => {
    const env = buildSpawnEnv();
    const segs = (env.PATH as string).split(path.delimiter);
    // One representative wrapper from each non-agent-hub domain skill.
    for (const name of ['gh-pr.sh', 'gcloud-q.sh', 'google-cal.sh', 'op-read.sh']) {
      const hit = segs
        .map((d) => path.join(d, name))
        .find((p) => existsSync(p) && (statSync(p).mode & 0o111) !== 0);
      expect(hit, `${name} must be resolvable + executable on the spawn PATH`).toBeTruthy();
    }
  });
});
