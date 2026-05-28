import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';
import { CONNECT_GITHUB_HINT } from './github-auth-policy.js';

vi.mock('./github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

vi.mock('./github-oauth.js', () => ({
  githubUserApiRequest: vi.fn(),
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
    allValidModels: [],
    ...overrides,
  } as AppConfig;
}

describe('fetchPrDetail', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses reviewer GitHub App when reviewerAppRead is set', async () => {
    const { githubApiRequest, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(999);

    (githubApiRequest as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) => {
      if (path.endsWith('/pulls/42')) {
        return {
          number: 42,
          title: 'Fix thing',
          state: 'open',
          draft: false,
          html_url: 'https://github.com/o/r/pull/42',
          user: { login: 'alice' },
          head: { ref: 'feature/x', sha: 'abc123' },
          base: { ref: 'main' },
          mergeable: true,
          mergeable_state: 'clean',
        };
      }
      if (path.includes('/reviews')) {
        return [{ id: 1, user: { login: 'bob' }, state: 'APPROVED', body: 'lgtm' }];
      }
      if (path.includes('/issues/42/comments')) {
        return [];
      }
      if (path.includes('/check-runs')) {
        return { check_runs: [] };
      }
      return null;
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const config = baseConfig({
      githubApp: {
        appId: '1',
        privateKey: 'k',
        installationId: 999,
        installations: [{ id: 999, account: 'o', accountType: 'Organization' }],
      },
    });
    const out = await fetchPrDetail(config, { owner: 'o', repo: 'r' }, 42, {
      reviewerAppRead: true,
    });

    expect(out.source).toBe('github-app');
    expect((out.pr as Record<string, unknown>).number).toBe(42);
    // The head SHA is hoisted to top-level `headSha` because
    // normalizePrSummary collapses `pr.head` into a branch-ref string.
    // Callers that create commit-scoped artifacts (e.g. reviewer Check Runs)
    // depend on this; before PR #1161 they were silently getting undefined.
    expect(out.headSha).toBe('abc123');
  });

  it('uses user OAuth when userAccessToken is provided', async () => {
    const { githubUserApiRequest } = await import('./github-oauth.js');
    (githubUserApiRequest as ReturnType<typeof vi.fn>).mockImplementation(async ({ endpoint }) => {
      if (endpoint.endsWith('/pulls/7')) {
        return {
          number: 7,
          title: 'User path',
          state: 'open',
          user: { login: 'alice' },
          head: { sha: 'abc' },
        };
      }
      return [];
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const out = await fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 7, {
      userAccessToken: 'gho_test',
    });
    expect(out.source).toBe('user-oauth');
    expect((out.pr as Record<string, unknown>).number).toBe(7);
    expect(out.headSha).toBe('abc');
  });

  it('returns headSha=null when the GitHub payload has no head SHA', async () => {
    const { githubUserApiRequest } = await import('./github-oauth.js');
    (githubUserApiRequest as ReturnType<typeof vi.fn>).mockImplementation(async ({ endpoint }) => {
      if (endpoint.endsWith('/pulls/8')) {
        // Edge case: deleted-branch / GhostPR — `head` is missing entirely.
        return {
          number: 8,
          title: 'GhostPR',
          state: 'closed',
          user: { login: 'alice' },
        };
      }
      return [];
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const out = await fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 8, {
      userAccessToken: 'gho_test',
    });
    expect(out.headSha).toBeNull();
  });

  it('throws when no user token and reviewerAppRead is false', async () => {
    const { fetchPrDetail, PrFetchError } = await import('./pr-detail-fetch.js');
    await expect(fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
      PrFetchError,
    );
    await expect(fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
      CONNECT_GITHUB_HINT,
    );
  });

  it('does not fall back to App when user token fails', async () => {
    const { githubUserApiRequest } = await import('./github-oauth.js');
    (githubUserApiRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 bad'));

    const { fetchPrDetail, PrFetchError } = await import('./pr-detail-fetch.js');
    await expect(
      fetchPrDetail(
        baseConfig({ githubApp: { appId: '1', privateKey: 'k', installationId: 1 } }),
        {
          owner: 'o',
          repo: 'r',
        },
        1,
        { userAccessToken: 'gho_bad' },
      ),
    ).rejects.toThrow(PrFetchError);
  });
});
