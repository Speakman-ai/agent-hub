import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  lookupInstallationIdForOwner,
  mintInstallationTokenForOwner,
  validateTokenForRepo,
  resolveGithubSpawnToken,
  clearInstallationLookupCache,
} from './github-spawn-token-resolver.js';
import type { GitHubAppConfig, AppConfig } from './types.js';

function makeApp(overrides: Partial<GitHubAppConfig> = {}): GitHubAppConfig {
  return {
    appId: '12345',
    privateKey: '---FAKE KEY---',
    installations: [],
    ...overrides,
  } as GitHubAppConfig;
}

function makeConfig(
  app: GitHubAppConfig | null,
  botToken: string | null = null,
): Pick<AppConfig, 'githubApp' | 'botGithubToken'> {
  return { githubApp: app, botGithubToken: botToken } as Pick<
    AppConfig,
    'githubApp' | 'botGithubToken'
  >;
}

beforeEach(() => clearInstallationLookupCache());

describe('lookupInstallationIdForOwner', () => {
  it('returns null when app is null', () => {
    expect(lookupInstallationIdForOwner(null, 'mcsteen')).toBeNull();
  });

  it('returns null when owner is empty', () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    expect(lookupInstallationIdForOwner(app, '')).toBeNull();
    expect(lookupInstallationIdForOwner(app, null)).toBeNull();
    expect(lookupInstallationIdForOwner(app, undefined)).toBeNull();
  });

  it('returns installation id for matching owner', () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    expect(lookupInstallationIdForOwner(app, 'mcsteen')).toBe(99);
  });

  it('matches owner case-insensitively', () => {
    const app = makeApp({
      installations: [{ id: 77, account: 'Speakman-AI', accountType: 'Organization' }],
    });
    expect(lookupInstallationIdForOwner(app, 'speakman-ai')).toBe(77);
    expect(lookupInstallationIdForOwner(app, 'SPEAKMAN-AI')).toBe(77);
  });

  it('returns null for an owner that is NOT in installations[] even when a default installationId exists', () => {
    // This is the core security invariant: never use one org's
    // installation token to clone another org's repo.
    const app = makeApp({
      installationId: 99,
      installations: [{ id: 99, account: 'other-org', accountType: 'Organization' }],
    });
    expect(lookupInstallationIdForOwner(app, 'mcsteen')).toBeNull();
  });

  it('caches lookups per (appId, owner) for repeated calls', () => {
    const app = makeApp({
      installations: [{ id: 42, account: 'foo', accountType: 'Organization' }],
    });
    const first = lookupInstallationIdForOwner(app, 'foo');
    // Mutate the underlying app config after the first call. If the
    // cache is honoured the second call still returns the original id.
    app.installations = [];
    const second = lookupInstallationIdForOwner(app, 'foo');
    expect(first).toBe(42);
    expect(second).toBe(42);
  });

  it('keeps separate cache entries for distinct owners', () => {
    const app = makeApp({
      installations: [
        { id: 1, account: 'a', accountType: 'Organization' },
        { id: 2, account: 'b', accountType: 'Organization' },
      ],
    });
    expect(lookupInstallationIdForOwner(app, 'a')).toBe(1);
    expect(lookupInstallationIdForOwner(app, 'b')).toBe(2);
  });
});

describe('mintInstallationTokenForOwner', () => {
  it('returns null when githubApp is null', async () => {
    const cfg = makeConfig(null);
    const token = await mintInstallationTokenForOwner(
      cfg,
      'mcsteen',
      async () => 'ghs_should_not_call',
    );
    expect(token).toBeNull();
  });

  it('returns null when owner is empty', async () => {
    const cfg = makeConfig(makeApp());
    expect(await mintInstallationTokenForOwner(cfg, null, async () => 'x')).toBeNull();
    expect(await mintInstallationTokenForOwner(cfg, '', async () => 'x')).toBeNull();
  });

  it('mints a token when the owner is in installations[]', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const minter = vi.fn(async (appId, _key, instId) => `ghs_appid${appId}_inst${instId}`);
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter);
    expect(token).toBe('ghs_appid12345_inst99');
    expect(minter).toHaveBeenCalledTimes(1);
  });

  it('triggers lazy refresh of installations[] on cache miss and mints when refresh adds the owner', async () => {
    const app = makeApp({ installations: [] });
    const cfg = makeConfig(app);
    const lister = vi.fn(async () => [
      { id: 555, account: { login: 'mcsteen', type: 'Organization' } },
    ]);
    const minter = vi.fn(async (_app, _key, instId) => `ghs_inst${instId}`);
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, lister);
    expect(lister).toHaveBeenCalledTimes(1);
    expect(token).toBe('ghs_inst555');
    expect(app.installations).toEqual([
      { id: 555, account: 'mcsteen', accountType: 'Organization' },
    ]);
  });

  it('returns null when refresh still does not find the owner', async () => {
    const app = makeApp({ installations: [] });
    const cfg = makeConfig(app);
    const lister = vi.fn(async () => [
      { id: 999, account: { login: 'someone-else', type: 'User' } },
    ]);
    const minter = vi.fn(async () => 'should_not_be_called');
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, lister);
    expect(token).toBeNull();
    expect(minter).not.toHaveBeenCalled();
  });

  it('returns null and logs when the token-mint call throws', async () => {
    const app = makeApp({
      installations: [{ id: 1, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const minter = vi.fn(async () => {
      throw new Error('App private key rejected');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter);
    expect(token).toBeNull();
    expect(errSpy).toHaveBeenCalled();
    const logLine = String(errSpy.mock.calls[0]?.[0] ?? '');
    expect(logLine).toMatch(/TOOL_ERROR/);
    expect(logLine).toMatch(/app-installation-token/);
    errSpy.mockRestore();
  });

  it('rate-limits the lazy refresh per (appId, owner) so a hot loop does not hammer the API', async () => {
    const app = makeApp({ installations: [] });
    const cfg = makeConfig(app);
    const lister = vi.fn(async () => []);
    const minter = vi.fn(async () => 'unused');
    await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, lister);
    await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, lister);
    await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, lister);
    expect(lister).toHaveBeenCalledTimes(1);
  });
});

describe('validateTokenForRepo', () => {
  it('returns false for empty inputs', async () => {
    const fetcher = vi.fn();
    expect(await validateTokenForRepo(null, 'a', 'b', fetcher as never)).toBe(false);
    expect(await validateTokenForRepo('t', '', 'b', fetcher as never)).toBe(false);
    expect(await validateTokenForRepo('t', 'a', '', fetcher as never)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns true on a 200 response', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    expect(await validateTokenForRepo('token', 'mcsteen', 'surveytracker', fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/mcsteen/surveytracker',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'token token',
        }),
      }),
    );
  });

  it('returns false on a 401', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 401 }));
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });

  it('returns false on a 403', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 403 }));
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });

  it('returns false on a network error (does not throw)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });
});

describe('resolveGithubSpawnToken', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('prefers the App installation token when the App is installed on the repo owner', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app, 'bot-pat');
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_installation_token',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('ghs_installation_token');
  });

  it('returns the App token without validation when only owner is known (no repo name)', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app, 'bot-pat');
    const validate = vi.fn(async () => ({ ok: true, status: 200 }));
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: null,
      repoOwner: 'mcsteen',
      tokenMinter: async () => 'ghs_token',
      validateFetcher: validate,
    });
    expect(token).toBe('ghs_token');
    expect(validate).not.toHaveBeenCalled();
  });

  it('falls through to the next candidate when the App token fails pre-validation', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app, 'bot-pat');
    const validate = vi.fn(async (url: string) => {
      // App token fails (401 simulating revoked installation), bot
      // token succeeds.
      if (String(url).includes('mcsteen/surveytracker')) {
        return { ok: false, status: 401 };
      }
      return { ok: true, status: 200 };
    });
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_dead',
      validateFetcher: async (url, init) => {
        // First call (App token) -> 401, second call (bot token) -> 200
        const auth = init?.headers?.Authorization ?? '';
        if (auth.includes('ghs_dead')) return { ok: false, status: 401 };
        return { ok: true, status: 200 };
      },
    });
    expect(token).toBe('bot-pat');
    // The fall-through should have logged a TOOL_ERROR for the dead App token.
    expect(errSpy).toHaveBeenCalled();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/app-installation-token/);
    void validate;
  });

  it('reviewer role uses botGithubToken when no App is configured', async () => {
    const cfg = makeConfig(null, 'bot-pat');
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('bot-pat');
  });

  it('reviewer role returns null when bot token fails pre-validation', async () => {
    const cfg = makeConfig(null, 'bot-pat');
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      validateFetcher: async () => ({ ok: false, status: 403 }),
    });
    expect(token).toBeNull();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/reviewer-bot-token/);
  });

  it('reviewer role returns null when bot token is missing and no App match', async () => {
    const cfg = makeConfig(null, null);
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
    });
    expect(token).toBeNull();
  });

  it('autonomous-dispatch non-reviewer returns null instead of falling back to user OAuth', async () => {
    const cfg = makeConfig(null, null);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      autonomousOrigin: true,
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    // Security invariant: autonomous-dispatch must NOT fall back to a
    // human's personal OAuth token, even if it would have validated.
    expect(token).toBeNull();
  });

  it('non-reviewer interactive falls back to user OAuth when the App is not installed on the org', async () => {
    const cfg = makeConfig(makeApp({ installations: [] }), null);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'personal-account',
      repoName: 'side-project',
      installationLister: async () => [],
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('gho_user_pat');
  });

  it('non-reviewer interactive returns null and logs when user OAuth token is revoked', async () => {
    const cfg = makeConfig(null, null);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_dead_token',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      validateFetcher: async () => ({ ok: false, status: 403 }),
    });
    expect(token).toBeNull();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/user-oauth-token/);
    expect(lines).toMatch(/grant likely revoked/);
  });

  it('non-reviewer interactive returns user OAuth without validation when repo info is missing', async () => {
    const cfg = makeConfig(null, null);
    const validate = vi.fn();
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: null,
      repoName: null,
      validateFetcher: validate as never,
    });
    expect(token).toBe('gho_user_pat');
    expect(validate).not.toHaveBeenCalled();
  });

  it('returns null when no candidate produces a token (no App, no bot, no user)', async () => {
    const cfg = makeConfig(null, null);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: null,
    });
    expect(token).toBeNull();
  });
});
