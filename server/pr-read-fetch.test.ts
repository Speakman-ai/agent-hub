import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

// Mock the GitHub App helpers — the App-tier path under test calls
// `getInstallationToken` + `resolveInstallationId` when `reviewerAppRead`
// is true and a Reviewer GitHub App installation is configured.
vi.mock('./github-app.js', () => ({
  getInstallationToken: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 3051,
    host: 'localhost',
    claudeBin: '/usr/local/bin/claude',
    cursorBin: '/usr/local/bin/cursor-agent',
    defaultCwd: '/tmp',
    dataDir: '/tmp',
    projectsDir: '/tmp',
    defaultModel: 'sonnet',
    engineDefaultModels: {},
    engineValidModels: {},
    defaultTimeoutMs: 60_000,
    docsTimeoutMs: 60_000,
    slackTimeoutMs: 60_000,
    conferenceTimeoutMs: 60_000,
    publicUrl: null,
    defaultReviewer: null,
    botGithubToken: null,
    githubApp: null,
    apiKey: null,
    anthropicApiKey: null,
    openaiApiKey: null,
    slackWebhookUrl: null,
    capturesEnabled: false,
    allValidModels: [],
    ...overrides,
  } as AppConfig;
}

const TEST_APP: NonNullable<AppConfig['githubApp']> = {
  appId: '12345',
  privateKey: '-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----',
  installationId: 67890,
  installations: [{ id: 67890, account: 'mcsteen', accountType: 'Organization' }],
  appSlug: 'agent-hub-reviewer-test',
};

// The fetchPrDiff/fetchPrFiles helpers used to layer a `gh` CLI fallback
// onto the user-OAuth → App ladder. After the "drop App fallbacks" refactor
// (PR #1069) the policy collapsed to two lanes:
//
//   1. `userAccessToken` present → user-OAuth (no fallback on failure).
//   2. `reviewerAppRead: true` + App installed → App installation token
//      (no fallback on failure).
//   3. Anything else → throw `CONNECT_GITHUB_HINT`.
//
// The tests below pin those three branches. Mocks for `gh` CLI fallback are
// gone — there is no longer a CLI path to exercise.

describe('fetchPrDiff', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses the user OAuth token when one is provided (lane 1)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.github.v3.diff' },
      }),
    );

    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    const result = await fetchPrDiff(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'mcsteen', repo: 'surveytracker' },
      621,
      { userAccessToken: 'user-tok', fetchImpl },
    );

    expect(result.source).toBe('user-oauth');
    expect(result.diff).toContain('diff --git a/foo b/foo');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://api.github.com/repos/mcsteen/surveytracker/pulls/621');
    expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer user-tok');
    expect((init?.headers as Record<string, string>)?.Accept).toBe(
      'application/vnd.github.v3.diff',
    );
  });

  it('uses the Reviewer GitHub App installation token when reviewerAppRead is true and no user token is provided (lane 2)', async () => {
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('inst-token-xyz');

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('--- diff body ---\n', { status: 200 }));

    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    const result = await fetchPrDiff(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'mcsteen', repo: 'surveytracker' },
      621,
      { reviewerAppRead: true, fetchImpl },
    );

    expect(result.source).toBe('github-app');
    expect(result.diff).toBe('--- diff body ---\n');
    expect((getInstallationToken as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token inst-token-xyz');
    expect(headers.Accept).toBe('application/vnd.github.v3.diff');
  });

  it('user-OAuth lane does NOT silently fall back to the App when the user request fails', async () => {
    // The "drop App fallbacks" refactor explicitly removed the ladder:
    // a failing user-OAuth read is now a hard error so the caller can
    // surface the connect-GitHub hint instead of silently degrading to
    // the App identity.
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('inst-token');

    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('bad token', { status: 401 }));

    const { fetchPrDiff, PrReadFetchError } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrDiff(baseConfig({ githubApp: TEST_APP }), { owner: 'o', repo: 'r' }, 1, {
        userAccessToken: 'stale',
        reviewerAppRead: true,
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PrReadFetchError);

    // Only one fetch attempt: the user-OAuth lane. No App-tier retry.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect((getInstallationToken as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('throws CONNECT_GITHUB_HINT when neither user token nor reviewerAppRead is provided', async () => {
    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrDiff(baseConfig({ githubApp: TEST_APP }), { owner: 'o', repo: 'r' }, 1, {
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/Connect your GitHub account/i);
  });

  it('throws CONNECT_GITHUB_HINT when reviewerAppRead is set but no App is installed', async () => {
    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrDiff(baseConfig({ githubApp: null }), { owner: 'o', repo: 'r' }, 1, {
        reviewerAppRead: true,
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/Connect your GitHub account/i);
  });

  it('attaches appTierError to PrReadFetchError when the App tier throws', async () => {
    // Diagnostic surfacing — the route handler needs the App-tier error so the
    // operator-facing 502 can name what GitHub rejected, even though the lane
    // has no further fallback to try.
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('inst-token');

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('Resource not accessible by integration', { status: 403 }));

    const { fetchPrDiff, PrReadFetchError } = await import('./pr-read-fetch.js');
    try {
      await fetchPrDiff(baseConfig({ githubApp: TEST_APP }), { owner: 'o', repo: 'r' }, 1, {
        reviewerAppRead: true,
        fetchImpl,
      });
      throw new Error('expected fetchPrDiff to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrReadFetchError);
      expect((err as Error).message).toMatch(/403/);
      expect((err as InstanceType<typeof PrReadFetchError>).appTierError).toMatch(/403/);
    }
  });
});

describe('fetchPrFiles', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('paginates the files endpoint until a short page is returned (App lane)', async () => {
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('tok');

    // Page 1 is full (100 entries); page 2 is short (3 entries) → stop.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    const page2 = [
      { filename: 'last1.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
      { filename: 'last2.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
      { filename: 'last3.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const { fetchPrFiles } = await import('./pr-read-fetch.js');
    const result = await fetchPrFiles(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'o', repo: 'r' },
      99,
      { reviewerAppRead: true, fetchImpl },
    );

    expect(result.source).toBe('github-app');
    expect(result.files).toHaveLength(103);
    expect(result.truncated).toBe(false);
    // Verify URLs include `page=` and that the second call is page=2.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('page=1');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page=2');
  });

  it('paginates the files endpoint under the user OAuth lane', async () => {
    // Same pagination behaviour must hold for the user-OAuth lane —
    // covers the case where a card with many changed files is opened
    // from a session that has its own per-user token.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `u${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
      changes: 1,
    }));
    const page2 = [
      { filename: 'tail.ts', status: 'added', additions: 1, deletions: 0, changes: 1 },
    ];

    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }));

    const { fetchPrFiles } = await import('./pr-read-fetch.js');
    const result = await fetchPrFiles(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'o', repo: 'r' },
      99,
      { userAccessToken: 'user-tok', fetchImpl },
    );

    expect(result.source).toBe('user-oauth');
    expect(result.files).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('page=1');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page=2');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer user-tok',
    );
  });

  it('respects the user OAuth lane when a user token is supplied', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify([
            { filename: 'a.ts', status: 'modified', additions: 5, deletions: 1, changes: 6 },
          ]),
          { status: 200 },
        ),
      );

    const { fetchPrFiles } = await import('./pr-read-fetch.js');
    const result = await fetchPrFiles(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'o', repo: 'r' },
      7,
      { userAccessToken: 'user-tok', fetchImpl },
    );

    expect(result.source).toBe('user-oauth');
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer user-tok',
    );
  });

  it('throws CONNECT_GITHUB_HINT when neither user token nor reviewerAppRead is provided', async () => {
    const { fetchPrFiles } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrFiles(baseConfig({ githubApp: TEST_APP }), { owner: 'o', repo: 'r' }, 7, {
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/Connect your GitHub account/i);
  });

  it('attaches appTierError to PrReadFetchError when the App tier throws (files)', async () => {
    // Diagnostic-surfacing parity with fetchPrDiff: the App-tier error must
    // propagate as a `PrReadFetchError.appTierError` so the route handler
    // can render a meaningful 502 instead of a generic message.
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('inst-token');

    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('Resource not accessible by integration', { status: 403 }));

    const { fetchPrFiles, PrReadFetchError } = await import('./pr-read-fetch.js');
    try {
      await fetchPrFiles(baseConfig({ githubApp: TEST_APP }), { owner: 'o', repo: 'r' }, 7, {
        reviewerAppRead: true,
        fetchImpl,
      });
      throw new Error('expected fetchPrFiles to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PrReadFetchError);
      expect((err as Error).message).toMatch(/403/);
      expect((err as InstanceType<typeof PrReadFetchError>).appTierError).toMatch(/403/);
    }
  });
});
