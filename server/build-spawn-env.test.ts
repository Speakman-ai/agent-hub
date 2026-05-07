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
// extraEnv / EXTRA_ENV_ALLOWLIST gate (chat.ts)
//
// chat.ts applies an explicit allowlist before merging msg.extraEnv into
// spawnEnv. These tests lock in the three invariants so a future refactor
// can't accidentally widen the gate and let callers shadow auth variables.
//
// The applyExtraEnv helper mirrors the exact loop in chat.ts. If that logic
// changes, update both the helper and these tests.
// ─────────────────────────────────────────────────────────────────────────────

describe('EXTRA_ENV_ALLOWLIST — extraEnv gate in chat.ts', () => {
  // Mirrors EXTRA_ENV_ALLOWLIST from chat.ts. Update here whenever a new key
  // is added to the allowlist in production.
  const EXTRA_ENV_ALLOWLIST = new Set(['DEV_HUB_API_KEY']);

  function applyExtraEnv(spawnEnv: Record<string, string>, extraEnv: Record<string, string>): void {
    for (const [key, val] of Object.entries(extraEnv)) {
      if (EXTRA_ENV_ALLOWLIST.has(key) && !(key in spawnEnv)) {
        spawnEnv[key] = val;
      }
    }
  }

  it('allowlisted key (DEV_HUB_API_KEY) is accepted when spawnEnv does not have it', () => {
    const spawnEnv: Record<string, string> = { PATH: '/usr/bin' };
    applyExtraEnv(spawnEnv, { DEV_HUB_API_KEY: 'ahub_key' });
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('ahub_key');
    expect(spawnEnv.PATH).toBe('/usr/bin'); // pre-existing key undisturbed
  });

  it('allowlisted key is silently dropped when spawnEnv already has it', () => {
    const spawnEnv: Record<string, string> = { DEV_HUB_API_KEY: 'server-set' };
    applyExtraEnv(spawnEnv, { DEV_HUB_API_KEY: 'caller-override' });
    expect(spawnEnv.DEV_HUB_API_KEY).toBe('server-set');
  });

  it('non-allowlisted GH_TOKEN is silently dropped — cannot shadow server auth', () => {
    const spawnEnv: Record<string, string> = { GH_TOKEN: 'server-token' };
    applyExtraEnv(spawnEnv, { GH_TOKEN: 'caller-token' });
    expect(spawnEnv.GH_TOKEN).toBe('server-token');
  });

  it('non-allowlisted ANTHROPIC_API_KEY is dropped even when absent from spawnEnv', () => {
    const spawnEnv: Record<string, string> = {};
    applyExtraEnv(spawnEnv, { ANTHROPIC_API_KEY: 'sk-ant-caller' });
    expect(spawnEnv.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
