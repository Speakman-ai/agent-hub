import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';
import { CONNECT_GITHUB_HINT } from './github-auth-policy.js';

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

  it('throws CONNECT_GITHUB_HINT when no user token is provided', async () => {
    const { fetchPrDetail, PrFetchError } = await import('./pr-detail-fetch.js');
    await expect(fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
      PrFetchError,
    );
    await expect(fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
      CONNECT_GITHUB_HINT,
    );
  });

  it('does not fall back when the user token fails', async () => {
    const { githubUserApiRequest } = await import('./github-oauth.js');
    (githubUserApiRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('401 bad'));

    const { fetchPrDetail, PrFetchError } = await import('./pr-detail-fetch.js');
    await expect(
      fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1, { userAccessToken: 'gho_bad' }),
    ).rejects.toThrow(PrFetchError);
  });
});
