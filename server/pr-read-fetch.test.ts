import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

// Mock the GitHub App helpers — the helper under test calls
// `getInstallationToken` + `resolveInstallationId` for tier 1.
vi.mock('./github-app.js', () => ({
  getInstallationToken: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

// Mock the gh CLI tier the same way `pr-detail-fetch.test.ts` does, so a
// stray CLI tier execution surfaces as a test-time failure (the global
// fixture forbids real `gh` spawns anyway).
const cliMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: () => cliMock,
  };
});

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
  installations: [],
  appSlug: 'agent-hub-reviewer-test',
};

describe('fetchPrDiff', () => {
  beforeEach(() => {
    vi.resetModules();
    cliMock.mockReset();
  });

  it('uses the user OAuth token when one is provided (tier 0)', async () => {
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

  it('falls back to GitHub App when no user token is provided (tier 1)', async () => {
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
      { fetchImpl },
    );

    expect(result.source).toBe('github-app');
    expect(result.diff).toBe('--- diff body ---\n');
    expect((getInstallationToken as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const headers = fetchImpl.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('token inst-token-xyz');
    expect(headers.Accept).toBe('application/vnd.github.v3.diff');
  });

  it('falls back from user-OAuth to GitHub App when tier 0 throws', async () => {
    const { getInstallationToken, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(67890);
    (getInstallationToken as ReturnType<typeof vi.fn>).mockResolvedValue('inst-token');

    const fetchImpl = vi
      .fn()
      // Tier 0 returns 401 — should fall through, NOT propagate
      .mockResolvedValueOnce(new Response('bad token', { status: 401 }))
      .mockResolvedValueOnce(new Response('--- app diff ---', { status: 200 }));

    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    const result = await fetchPrDiff(
      baseConfig({ githubApp: TEST_APP }),
      { owner: 'o', repo: 'r' },
      1,
      { userAccessToken: 'stale', fetchImpl },
    );

    expect(result.source).toBe('github-app');
    expect(result.diff).toBe('--- app diff ---');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws when every tier is unavailable', async () => {
    const { fetchPrDiff } = await import('./pr-read-fetch.js');
    cliMock.mockRejectedValue(new Error('gh: command not found'));

    await expect(
      fetchPrDiff(baseConfig({ githubApp: null }), { owner: 'o', repo: 'r' }, 1, {
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow(/gh: command not found/);
  });
});

describe('fetchPrFiles', () => {
  beforeEach(() => {
    vi.resetModules();
    cliMock.mockReset();
  });

  it('paginates the files endpoint until a short page is returned', async () => {
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
      { fetchImpl },
    );

    expect(result.source).toBe('github-app');
    expect(result.files).toHaveLength(103);
    expect(result.truncated).toBe(false);
    // Verify URLs include `page=` and that the second call is page=2.
    expect(String(fetchImpl.mock.calls[0][0])).toContain('page=1');
    expect(String(fetchImpl.mock.calls[1][0])).toContain('page=2');
  });

  it('respects the user OAuth tier when a user token is supplied', async () => {
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
});
