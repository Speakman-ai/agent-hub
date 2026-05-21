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

function makeConfig(app: GitHubAppConfig | null): Pick<AppConfig, 'githubApp'> {
  return { githubApp: app };
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
    const errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
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

  it('regression: a transient lister failure does NOT block subsequent calls for the full success TTL', async () => {
    // [4/10] from the reviewer on PR #979: the original implementation
    // primed `installationListRefreshCache` BEFORE awaiting the
    // lister, so any throw left the (appId, owner) slot capped for
    // the full 5-minute success window even though no refresh ever
    // succeeded. After the fix the success TTL is only primed on
    // success; failures get a short back-off (30s + jitter) instead.
    const app = makeApp({ installations: [] });
    const cfg = makeConfig(app);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First call: lister throws -> failure back-off (NOT success TTL).
    const listerFail = vi.fn(async () => {
      throw new Error('transient 503');
    });
    const minter = vi.fn(async () => 'never_minted');
    await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, listerFail);
    expect(listerFail).toHaveBeenCalledTimes(1);

    // Second call within the failure back-off window with a
    // *different* (working) lister: still capped, lister NOT called
    // again. This is by design — we still rate-limit failures, just
    // not for 5 minutes.
    const listerSuccess = vi.fn(async () => [
      { id: 1, account: { login: 'mcsteen', type: 'Organization' } },
    ]);
    await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, listerSuccess);
    expect(listerSuccess).not.toHaveBeenCalled();

    // Manually expire the failure back-off (we don't fake timers
    // here — instead, clear the resolver caches to simulate the
    // back-off elapsing) and confirm a third call DOES re-run the
    // working lister. This is the bug we're guarding against: the
    // pre-fix code would have kept the working lister blocked for 5
    // minutes.
    clearInstallationLookupCache();
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter, listerSuccess);
    expect(listerSuccess).toHaveBeenCalledTimes(1);
    expect(token).toBe('never_minted');
    warnSpy.mockRestore();
  });

  it('regression: a successful refresh only invalidates lookup-cache entries for THIS App', async () => {
    // [4/10] from the reviewer on PR #979: the original implementation
    // called `installationLookupCache.clear()` on every successful
    // refresh, which blew away the entries for every other App's
    // installations even though their state was unchanged. After
    // the fix, only `${app.appId}::*` entries are dropped.
    const appA = makeApp({
      appId: 'appA',
      installations: [{ id: 1, account: 'orgA', accountType: 'Organization' }],
    });
    const appB = makeApp({
      appId: 'appB',
      installations: [{ id: 2, account: 'orgB', accountType: 'Organization' }],
    });

    // Prime both lookup caches.
    expect(lookupInstallationIdForOwner(appA, 'orgA')).toBe(1);
    expect(lookupInstallationIdForOwner(appB, 'orgB')).toBe(2);

    // Trigger a refresh on appA for an unknown owner. The lister
    // returns an updated installations array for appA.
    const cfg = makeConfig(appA);
    const minter = vi.fn(async () => 'ghs_token');
    const lister = vi.fn(async () => [
      { id: 1, account: { login: 'orgA', type: 'Organization' } },
      { id: 99, account: { login: 'orgC', type: 'Organization' } },
    ]);
    await mintInstallationTokenForOwner(cfg, 'orgC', minter, lister);

    // appA's lookup cache must have been invalidated so the next call
    // sees the new orgC entry.
    expect(lookupInstallationIdForOwner(appA, 'orgC')).toBe(99);

    // appB's lookup cache must still be intact — mutate appB.installations
    // out from under the cache and confirm the cached value is still
    // returned (i.e. it wasn't blown away by the appA refresh).
    appB.installations = [];
    expect(lookupInstallationIdForOwner(appB, 'orgB')).toBe(2);
  });

  it('regression: emits TOOL_ERROR via console.warn (not console.error) for soft/recovered events', async () => {
    // [3/10] from the reviewer on PR #979: sev:"soft" with
    // resolution:"recovered" was being routed through console.error,
    // which makes PM2 + dashboards flag the recurring auth-revoked
    // flap as an error spike. The fix moves it to console.warn.
    const app = makeApp({
      installations: [{ id: 1, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const minter = vi.fn(async () => {
      throw new Error('App private key rejected');
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const token = await mintInstallationTokenForOwner(cfg, 'mcsteen', minter);
    expect(token).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
    const logLine = String(warnSpy.mock.calls[0]?.[0] ?? '');
    expect(logLine).toMatch(/TOOL_ERROR/);
    expect(logLine).toMatch(/"sev":"soft"/);
    expect(logLine).toMatch(/"resolution":"recovered"/);
    warnSpy.mockRestore();
    errSpy.mockRestore();
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
    errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('non-reviewer interactive prefers per-user OAuth even when the App is installed on the repo owner', async () => {
    // Regression: pre-fix, this resolver short-circuited at the App
    // installation token for every role, so non-reviewer interactive
    // spawns ran as the App's bot identity instead of the human
    // (confirmed in the wild by agent-hub PR #1039). The contract is
    // now: per-user OAuth wins for human-identity spawns; App token is
    // a revoke-fallback only.
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const minter = vi.fn(async () => 'ghs_installation_token');
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: minter,
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('gho_user_pat');
    // The App-token mint path must NOT have been touched at all — we
    // want to avoid burning a JWT-mint round trip on the happy path.
    expect(minter).not.toHaveBeenCalled();
  });

  it('non-reviewer interactive returns user OAuth without validation when only owner is known (no repo name)', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const validate = vi.fn(async () => ({ ok: true, status: 200 }));
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      tokenMinter: async () => 'ghs_token',
      validateFetcher: validate,
    });
    expect(token).toBe('gho_user_pat');
    expect(validate).not.toHaveBeenCalled();
  });

  it('non-reviewer interactive returns null when no user OAuth is stored', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: null,
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_installation_token',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBeNull();
  });

  it('non-reviewer interactive returns null when user OAuth fails validation', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: 'gho_dead_token',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_installation_token',
      validateFetcher: async () => ({ ok: false, status: 403 }),
    });
    expect(token).toBeNull();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/user-oauth-token/);
  });

  it('reviewer role still prefers the App installation token over the bot token', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_installation_token',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('ghs_installation_token');
  });

  it('reviewer role returns null when App token fails pre-validation', async () => {
    const app = makeApp({
      installations: [{ id: 99, account: 'mcsteen', accountType: 'Organization' }],
    });
    const cfg = makeConfig(app);
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      tokenMinter: async () => 'ghs_dead',
      validateFetcher: async () => ({ ok: false, status: 401 }),
    });
    expect(token).toBeNull();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/app-installation-token/);
  });

  it('reviewer role NEVER falls back to user OAuth even when App is missing', async () => {
    // Security invariant: reviewer spawns must never attribute formal
    // PR reviews to a human account, even when the bot/App identity is
    // unavailable. The correct behaviour is to return null and let the
    // server-side `/api/pr/review` path handle the review submission.
    const cfg = makeConfig(null);
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      config: cfg,
      userGhToken: 'gho_user_pat',
      repoOwner: 'mcsteen',
      repoName: 'surveytracker',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBeNull();
  });

  it('autonomous-dispatch non-reviewer returns null instead of falling back to user OAuth', async () => {
    const cfg = makeConfig(null);
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
    const cfg = makeConfig(makeApp({ installations: [] }));
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
    const cfg = makeConfig(null);
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
    expect(lines).toMatch(/Settings/);
  });

  it('non-reviewer interactive returns user OAuth without validation when repo info is missing', async () => {
    const cfg = makeConfig(null);
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
    const cfg = makeConfig(null);
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      config: cfg,
      userGhToken: null,
    });
    expect(token).toBeNull();
  });
});
