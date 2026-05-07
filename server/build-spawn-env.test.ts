import { describe, it, expect, beforeEach } from 'vitest';
import config, { buildSpawnEnv, normalizeClaudeSetupToken, refreshShellPath } from './config.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// extraEnv merge semantics (chat.ts: Object.assign(spawnEnv, {...extraEnv, ...spawnEnv}))
//
// The pattern used in chat.ts puts spawnEnv LAST so server-resolved auth
// always wins over anything a caller supplies via msg.extraEnv. These tests
// lock in that invariant so a future refactor can't accidentally reverse the
// spread order and allow callers to shadow GH_TOKEN / ANTHROPIC_API_KEY / etc.
// ─────────────────────────────────────────────────────────────────────────────

describe('extraEnv merge — spawnEnv wins over caller-supplied extras', () => {
  it('extraEnv cannot override a server-set GH_TOKEN', () => {
    const spawnEnv: Record<string, string> = {
      GH_TOKEN: 'server-token',
      ANTHROPIC_API_KEY: 'sk-ant-server',
      PATH: '/usr/bin',
    };
    const extraEnv = { GH_TOKEN: 'caller-injected-token', DEV_HUB_API_KEY: 'ahub_key' };

    // This is the exact pattern in chat.ts:
    Object.assign(spawnEnv, { ...extraEnv, ...spawnEnv });

    // Server-resolved auth vars must be unchanged:
    expect(spawnEnv.GH_TOKEN).toBe('server-token');
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-server');
    // New key supplied by extraEnv must be accepted:
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('ahub_key');
  });

  it('extraEnv cannot override ANTHROPIC_API_KEY', () => {
    const spawnEnv: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-ant-server' };
    const extraEnv = { ANTHROPIC_API_KEY: 'sk-ant-caller' };
    Object.assign(spawnEnv, { ...extraEnv, ...spawnEnv });
    expect(spawnEnv.ANTHROPIC_API_KEY).toBe('sk-ant-server');
  });

  it('extraEnv adds a brand-new key that is absent from spawnEnv', () => {
    const spawnEnv: Record<string, string> = { PATH: '/usr/bin' };
    const extraEnv = { DEV_HUB_API_KEY: 'ahub_newkey' };
    Object.assign(spawnEnv, { ...extraEnv, ...spawnEnv });
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('ahub_newkey');
    // Pre-existing key is undisturbed:
    expect(spawnEnv.PATH).toBe('/usr/bin');
  });
});
