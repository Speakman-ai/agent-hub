import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppConfig } from './types.js';

// Mocks: GitHub App client and gh CLI. These are the two tiers of the fallback
// ladder — the helper should try the App first, then fall back to the CLI.
vi.mock('./github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

// We replace promisify so the returned `execFileAsync` is a vi.fn we can drive.
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

describe('fetchPrDetail', () => {
  beforeEach(() => {
    vi.resetModules();
    cliMock.mockReset();
  });

  it('uses the GitHub App when configured and merges reviews/checks/comments', async () => {
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
        return [
          { id: 1, user: { login: 'bob' }, state: 'CHANGES_REQUESTED', body: 'nope' },
          { id: 2, user: { login: 'eve' }, state: 'APPROVED', body: 'lgtm' },
        ];
      }
      if (path.includes('/issues/42/comments')) {
        return [{ id: 10, user: { login: 'carol' }, body: 'ping' }];
      }
      if (path.includes('/check-runs')) {
        return {
          check_runs: [
            {
              id: 100,
              name: 'ci',
              status: 'completed',
              conclusion: 'failure',
            },
          ],
        };
      }
      return null;
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const config = baseConfig({
      githubApp: {
        appId: '1',
        privateKey: 'k',
        installationId: 999,
      },
    });
    const out = await fetchPrDetail(config, { owner: 'o', repo: 'r' }, 42);

    expect(out.source).toBe('github-app');
    expect((out.pr as Record<string, unknown>).number).toBe(42);
    expect((out.pr as Record<string, unknown>).mergeable).toBe(true);
    expect(out.reviews).toHaveLength(2);
    expect(out.reviews[0]).toMatchObject({ user: 'bob', state: 'CHANGES_REQUESTED' });
    expect(out.checks).toHaveLength(1);
    expect(out.checks[0]).toMatchObject({ name: 'ci', conclusion: 'failure' });
    expect(out.comments).toHaveLength(1);
  });

  it('falls back to `gh` CLI when no GitHub App is configured', async () => {
    cliMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 7,
        title: 'CLI fallback path',
        state: 'OPEN',
        isDraft: false,
        url: 'https://github.com/o/r/pull/7',
        author: { login: 'alice' },
        headRefName: 'feature/y',
        baseRefName: 'main',
        createdAt: 't1',
        updatedAt: 't2',
        additions: 1,
        deletions: 0,
        changedFiles: 1,
        body: 'body',
        mergeable: 'CONFLICTING',
        reviewDecision: 'CHANGES_REQUESTED',
        labels: [],
        reviews: [
          {
            id: 1,
            author: { login: 'bob' },
            state: 'CHANGES_REQUESTED',
            body: 'fix',
            submittedAt: 't',
          },
        ],
        comments: [],
        statusCheckRollup: [
          { name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u' },
        ],
      }),
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const config = baseConfig();
    const out = await fetchPrDetail(config, { owner: 'o', repo: 'r' }, 7);

    expect(out.source).toBe('gh-cli');
    expect((out.pr as Record<string, unknown>).number).toBe(7);
    // `CONFLICTING` → false (via mergeableFromCli) AND preserved in mergeable_state
    expect((out.pr as Record<string, unknown>).mergeable).toBe(false);
    expect((out.pr as Record<string, unknown>).mergeable_state).toBe('CONFLICTING');
    expect(out.checks[0]).toMatchObject({ conclusion: 'failure', status: 'completed' });
    expect(out.reviews[0]).toMatchObject({ user: 'bob', state: 'CHANGES_REQUESTED' });
  });

  it('falls back to CLI when the App path throws', async () => {
    const { githubApiRequest, resolveInstallationId } = await import('./github-app.js');
    (resolveInstallationId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (githubApiRequest as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('App boom'));

    cliMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 1,
        title: 'cli rescue',
        state: 'OPEN',
        url: 'u',
        author: { login: 'a' },
        headRefName: 'h',
        baseRefName: 'b',
        labels: [],
        reviews: [],
        comments: [],
        statusCheckRollup: [],
        mergeable: 'MERGEABLE',
      }),
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const config = baseConfig({
      githubApp: { appId: '1', privateKey: 'k', installationId: 1 },
    });
    const out = await fetchPrDetail(config, { owner: 'o', repo: 'r' }, 1);
    expect(out.source).toBe('gh-cli');
    expect((out.pr as Record<string, unknown>).mergeable).toBe(true);
  });

  it('maps mergedAt and closedAt from `gh pr view` JSON on the CLI tier', async () => {
    cliMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 99,
        title: 'Merged via CLI',
        state: 'MERGED',
        isDraft: false,
        url: 'https://github.com/o/r/pull/99',
        author: { login: 'alice' },
        headRefName: 'feat',
        baseRefName: 'main',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        mergedAt: '2026-01-02T12:00:00Z',
        closedAt: '2026-01-02T12:00:00Z',
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        body: '',
        mergeable: 'UNKNOWN',
        reviewDecision: null,
        labels: [],
        reviews: [],
        comments: [],
        statusCheckRollup: [],
      }),
    });

    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    const config = baseConfig();
    const out = await fetchPrDetail(config, { owner: 'o', repo: 'r' }, 99);

    expect(out.source).toBe('gh-cli');
    expect((out.pr as Record<string, unknown>).merged_at).toBe('2026-01-02T12:00:00Z');
    expect((out.pr as Record<string, unknown>).closed_at).toBe('2026-01-02T12:00:00Z');
  });

  it('propagates CLI failure as an error when both tiers fail', async () => {
    cliMock.mockRejectedValue(new Error('gh: command not found'));
    const { fetchPrDetail } = await import('./pr-detail-fetch.js');
    await expect(fetchPrDetail(baseConfig(), { owner: 'o', repo: 'r' }, 1)).rejects.toThrow(
      /gh: command not found/,
    );
  });
});
