import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

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

// The reviewer GitHub App was removed; PR reads are strictly per-user:
//   1. `userAccessToken` present → user-OAuth (no fallback on failure).
//   2. Anything else → throw `CONNECT_GITHUB_HINT`.

describe('fetchPrDiff', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('uses the user OAuth token when one is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('diff --git a/foo b/foo\n--- a/foo\n+++ b/foo\n@@ -1 +1 @@\n-old\n+new\n', {
        status: 200,
        headers: { 'Content-Type': 'application/vnd.github.v3.diff' },
      }),
    );

    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    const result = await fetchPrDiff(
      baseConfig(),
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

  it('does not silently fall back when the user request fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response('bad token', { status: 401 }));

    const { fetchPrDiff, PrReadFetchError } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrDiff(baseConfig(), { owner: 'o', repo: 'r' }, 1, {
        userAccessToken: 'stale',
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(PrReadFetchError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('throws CONNECT_GITHUB_HINT when no user token is provided', async () => {
    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrDiff(baseConfig(), { owner: 'o', repo: 'r' }, 1, {
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/Connect your GitHub account/i);
  });
});

describe('fetchPrFiles', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('paginates the files endpoint under the user OAuth lane', async () => {
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
    const result = await fetchPrFiles(baseConfig(), { owner: 'o', repo: 'r' }, 99, {
      userAccessToken: 'user-tok',
      fetchImpl,
    });

    expect(result.source).toBe('user-oauth');
    expect(result.files).toHaveLength(101);
    expect(result.truncated).toBe(false);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('page=1');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page=2');
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer user-tok',
    );
  });

  it('returns a single short page under the user OAuth lane', async () => {
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
    const result = await fetchPrFiles(baseConfig(), { owner: 'o', repo: 'r' }, 7, {
      userAccessToken: 'user-tok',
      fetchImpl,
    });

    expect(result.source).toBe('user-oauth');
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(false);
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)?.Authorization).toBe(
      'Bearer user-tok',
    );
  });

  it('throws CONNECT_GITHUB_HINT when no user token is provided', async () => {
    const { fetchPrFiles } = await import('./pr-read-fetch.js');
    await expect(
      fetchPrFiles(baseConfig(), { owner: 'o', repo: 'r' }, 7, {
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/Connect your GitHub account/i);
  });
});
