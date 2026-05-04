import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('buildSpawnEnv — Nango integration env injection', () => {
  // Save / restore env so the leakage tests can't pollute later cases.
  const NANGO_KEYS = ['NANGO_SECRET_KEY', 'NANGO_PROVIDER_BASE', 'NANGO_CONNECTIONS_JSON'] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of NANGO_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of NANGO_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it('injects NANGO_SECRET_KEY / NANGO_PROVIDER_BASE / NANGO_CONNECTIONS_JSON when override provided', () => {
    const env = buildSpawnEnv(config, {
      nango: {
        secretKey: 'nango_secret_abc',
        providerBaseUrl: 'https://api.nango.dev',
        connections: { slack: 'conn_abc', 'google-mail': 'conn_def' },
      },
    });
    expect(env.NANGO_SECRET_KEY).toBe('nango_secret_abc');
    expect(env.NANGO_PROVIDER_BASE).toBe('https://api.nango.dev');
    expect(env.NANGO_CONNECTIONS_JSON).toBe(
      JSON.stringify({ slack: 'conn_abc', 'google-mail': 'conn_def' }),
    );
  });

  it('defaults NANGO_PROVIDER_BASE to https://api.nango.dev when not provided', () => {
    const env = buildSpawnEnv(config, {
      nango: { secretKey: 'nango_secret_abc', connections: {} },
    });
    expect(env.NANGO_PROVIDER_BASE).toBe('https://api.nango.dev');
  });

  it('honors a custom providerBaseUrl (self-hosted Nango)', () => {
    const env = buildSpawnEnv(config, {
      nango: {
        secretKey: 'nango_secret_abc',
        providerBaseUrl: 'https://nango.internal.example.com',
        connections: {},
      },
    });
    expect(env.NANGO_PROVIDER_BASE).toBe('https://nango.internal.example.com');
  });

  it('serialises an empty connections map as "{}" so consumers can JSON.parse unconditionally', () => {
    const env = buildSpawnEnv(config, {
      nango: { secretKey: 'nango_secret_abc' },
    });
    expect(env.NANGO_CONNECTIONS_JSON).toBe('{}');
  });

  it('does not inject any Nango vars when override is omitted', () => {
    const env = buildSpawnEnv(config, {});
    expect(env.NANGO_SECRET_KEY).toBeUndefined();
    expect(env.NANGO_PROVIDER_BASE).toBeUndefined();
    expect(env.NANGO_CONNECTIONS_JSON).toBeUndefined();
  });

  it('does not inject any Nango vars when secretKey is empty / whitespace', () => {
    const blank = buildSpawnEnv(config, { nango: { secretKey: '', connections: {} } });
    expect(blank.NANGO_SECRET_KEY).toBeUndefined();
    expect(blank.NANGO_PROVIDER_BASE).toBeUndefined();
    expect(blank.NANGO_CONNECTIONS_JSON).toBeUndefined();

    const ws = buildSpawnEnv(config, { nango: { secretKey: '   ', connections: {} } });
    expect(ws.NANGO_SECRET_KEY).toBeUndefined();
  });

  it('strips stale NANGO_* values from process.env when no override is supplied (no leakage)', () => {
    process.env.NANGO_SECRET_KEY = 'leaked_secret';
    process.env.NANGO_PROVIDER_BASE = 'https://leaked.example.com';
    process.env.NANGO_CONNECTIONS_JSON = '{"slack":"leaked_conn"}';
    const env = buildSpawnEnv(config, {});
    expect(env.NANGO_SECRET_KEY).toBeUndefined();
    expect(env.NANGO_PROVIDER_BASE).toBeUndefined();
    expect(env.NANGO_CONNECTIONS_JSON).toBeUndefined();
  });

  it('strips stale NANGO_* values when secretKey is null (matches the no-override behaviour)', () => {
    process.env.NANGO_SECRET_KEY = 'leaked_secret';
    process.env.NANGO_CONNECTIONS_JSON = '{"slack":"leaked_conn"}';
    const env = buildSpawnEnv(config, {
      nango: { secretKey: null, connections: { slack: 'should_not_appear' } },
    });
    expect(env.NANGO_SECRET_KEY).toBeUndefined();
    expect(env.NANGO_PROVIDER_BASE).toBeUndefined();
    expect(env.NANGO_CONNECTIONS_JSON).toBeUndefined();
  });

  it('keeps Nango env injection orthogonal to per-user Claude credentials', () => {
    // Both overrides applied at once — they should not interfere.
    const env = buildSpawnEnv(
      { ...config, anthropicApiKey: null, claudeCodeOAuthToken: null },
      {
        userOverride: { anthropicApiKey: 'sk-ant-api03-user', claudeCodeOAuthToken: null },
        nango: { secretKey: 'nango_secret_abc', connections: { slack: 'conn_abc' } },
      },
    );
    expect(env.ANTHROPIC_API_KEY).toBe('sk-ant-api03-user');
    expect(env.NANGO_SECRET_KEY).toBe('nango_secret_abc');
    expect(env.NANGO_CONNECTIONS_JSON).toBe(JSON.stringify({ slack: 'conn_abc' }));
  });

  it('JSON payload only contains the keys the caller passed (owner-scoped at the call site)', () => {
    // The store filtering happens in chat.ts; this asserts buildSpawnEnv
    // is a faithful pass-through and never adds keys of its own.
    const env = buildSpawnEnv(config, {
      nango: {
        secretKey: 'nango_secret_abc',
        connections: { slack: 'conn_owner_only' },
      },
    });
    const parsed = JSON.parse(env.NANGO_CONNECTIONS_JSON as string) as Record<string, string>;
    expect(Object.keys(parsed)).toEqual(['slack']);
    expect(parsed.slack).toBe('conn_owner_only');
  });
});
