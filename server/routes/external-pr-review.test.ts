import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';
import createExternalPrReviewRoutes, { parseGitHubPrUrl } from './external-pr-review.js';

vi.mock('../pr-detail-fetch.js', () => ({
  fetchPrDetail: vi.fn(),
}));

const hoisted = vi.hoisted(() => ({
  dispatchReviewerForPR: vi.fn(() => true),
  isReviewerDispatchPending: vi.fn(() => false),
}));

vi.mock('./webhooks.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    dispatchReviewerForPR: hoisted.dispatchReviewerForPR,
    isReviewerDispatchPending: hoisted.isReviewerDispatchPending,
  };
});

function buildDeps(overrides: Partial<RouteDeps> = {}): RouteDeps {
  return {
    config: { port: 3051, dataDir: '/tmp' },
    stmts: {
      getSessions: { all: vi.fn().mockReturnValue([]) },
      getFinalizeRunByPrUrl: { get: vi.fn().mockReturnValue(undefined) },
    },
    activeProcesses: new Map(),
    findProject: vi.fn(),
    ...overrides,
  } as unknown as RouteDeps;
}

function mount(deps: RouteDeps) {
  const app = express();
  app.use(express.json());
  app.use(createExternalPrReviewRoutes(deps));
  return app;
}

describe('parseGitHubPrUrl', () => {
  it('parses a canonical PR URL', () => {
    expect(parseGitHubPrUrl('https://github.com/acme/widgets/pull/42')).toEqual({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      canonical: 'https://github.com/acme/widgets/pull/42',
    });
  });

  it('accepts http and trims whitespace', () => {
    expect(parseGitHubPrUrl('  http://github.com/o/r/pull/7  ')).toEqual({
      owner: 'o',
      repo: 'r',
      number: 7,
      canonical: 'https://github.com/o/r/pull/7',
    });
  });

  it('accepts trailing path segments and fragments and produces the canonical form', () => {
    expect(parseGitHubPrUrl('https://github.com/o/r/pull/13/files')?.canonical).toBe(
      'https://github.com/o/r/pull/13',
    );
    expect(parseGitHubPrUrl('https://github.com/o/r/pull/13#issuecomment-1234')?.canonical).toBe(
      'https://github.com/o/r/pull/13',
    );
  });

  it('rejects non-PR URLs', () => {
    expect(parseGitHubPrUrl('https://github.com/o/r/issues/42')).toBeNull();
    expect(parseGitHubPrUrl('https://gitlab.com/o/r/-/merge_requests/1')).toBeNull();
    expect(parseGitHubPrUrl('https://example.com/o/r/pull/1')).toBeNull();
  });

  it('rejects malformed / non-string / zero values', () => {
    expect(parseGitHubPrUrl('')).toBeNull();
    expect(parseGitHubPrUrl(null)).toBeNull();
    expect(parseGitHubPrUrl(undefined)).toBeNull();
    expect(parseGitHubPrUrl('not-a-url')).toBeNull();
    expect(parseGitHubPrUrl('https://github.com/o/r/pull/0')).toBeNull();
  });

  it('accepts www. prefix', () => {
    expect(parseGitHubPrUrl('https://www.github.com/o/r/pull/9')?.number).toBe(9);
  });
});

describe('POST /api/projects/:projectId/external-pr-review', () => {
  beforeEach(async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockReset();
    // Match the real shape produced by fetchPrDetail → normalizePrSummary:
    // `pr.head` is the branch-ref STRING (not `{sha}`), and the head commit
    // SHA is hoisted to the top-level `headSha` field. The earlier mock used
    // `head: {sha: 'abc123'}` — a shape normalizePrSummary never produces —
    // which masked a real prod bug where the reviewer Check Run never spawned
    // (caught by PR #1161 round-4 review).
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'user-oauth',
      pr: {
        html_url: 'https://github.com/o/r/pull/3',
        title: 'External contributor: refactor cache',
        head: 'feature/refactor-cache',
        base: 'main',
      },
      reviews: [],
      checks: [],
      comments: [],
      headSha: 'abc123',
    });
    hoisted.dispatchReviewerForPR.mockReset().mockReturnValue(true);
    hoisted.isReviewerDispatchPending.mockReset().mockReturnValue(false);
  });

  it('returns 404 when project is unknown', async () => {
    const app = mount(buildDeps({ findProject: vi.fn().mockReturnValue(null) }));
    const res = await request(app)
      .post('/api/projects/ghost/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/1' });
    expect(res.status).toBe(404);
  });

  it('returns 400 when prUrl is missing or malformed', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );

    const missing = await request(app).post('/api/projects/p/external-pr-review').send({});
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/invalid pr url/i);

    const garbage = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'not-a-url' });
    expect(garbage.status).toBe(400);

    const wrongHost = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://example.com/o/r/pull/1' });
    expect(wrongHost.status).toBe(400);
  });

  it('returns 400 when project has no githubRepo configured', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/githubRepo/);
  });

  it('returns 400 when PR repo does not match project githubRepo', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/other/repo/pull/1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
    expect(hoisted.dispatchReviewerForPR).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive repo match', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'Acme/Widgets',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/acme/widgets/pull/4' });
    expect(res.status).toBe(202);
  });

  it('returns 400 when no reviewer agent is configured', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'lead', role: 'lead' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/1' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewer/i);
  });

  it('returns 409 when PR is classified as internal (Finalize-pushed)', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
        stmts: {
          getSessions: { all: vi.fn().mockReturnValue([]) },
          // Simulate a finalize_runs row keyed on this PR URL — registry hit.
          getFinalizeRunByPrUrl: {
            get: vi.fn().mockReturnValue({
              id: 'run-1',
              pr_url: 'https://github.com/o/r/pull/9',
            }),
          },
        } as never,
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/9' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/finalize|internal/i);
    expect(res.body.provenance).toBe('internal');
    expect(res.body.via).toBe('registry');
    expect(hoisted.dispatchReviewerForPR).not.toHaveBeenCalled();
  });

  it('returns 409 when a reviewer session is already in flight for this PR', async () => {
    const active = new Map();
    active.set('sess-busy', {});
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
        activeProcesses: active as never,
        stmts: {
          getSessions: {
            all: vi
              .fn()
              .mockReturnValue([{ id: 'sess-busy', agent_id: 'rev', name: 'Review: PR #5 Hello' }]),
          },
          getFinalizeRunByPrUrl: { get: vi.fn().mockReturnValue(undefined) },
        } as never,
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/5' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still running/i);
    expect(res.body.activeSessionId).toBe('sess-busy');
  });

  it('returns 409 when a dispatch is already debounced', async () => {
    hoisted.isReviewerDispatchPending.mockReturnValue(true);
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/2' });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/queued|debounce/i);
  });

  it('returns 404 when GitHub fetch reports the PR does not exist', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('GitHub returned 404 Not Found'),
    );
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/77' });
    expect(res.status).toBe(404);
  });

  it('returns 502 when GitHub fetch fails with a non-404 error', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('socket hangup'));
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/8' });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/socket hangup/);
  });

  it('returns 202 and schedules dispatch with reason=external-manual', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/3' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      ok: true,
      scheduled: true,
      prNumber: 3,
      repoFullName: 'o/r',
    });
    expect(hoisted.dispatchReviewerForPR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'p' }),
      expect.objectContaining({
        prNumber: 3,
        reason: 'external-manual',
        repoFullName: 'o/r',
        headSha: 'abc123',
        prTitle: 'External contributor: refactor cache',
      }),
    );
  });

  it('propagates the canonical PR URL into the dispatch when GitHub omits html_url', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      source: 'user-oauth',
      pr: { title: 'No html_url', head: 'feature/x', base: 'main' },
      reviews: [],
      checks: [],
      comments: [],
      headSha: 'def',
    });
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/11/files' });
    expect(res.status).toBe(202);
    expect(hoisted.dispatchReviewerForPR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        prUrl: 'https://github.com/o/r/pull/11',
        prNumber: 11,
        headSha: 'def',
      }),
    );
  });

  it('passes headSha=undefined when GitHub payload has no head SHA (deleted branch)', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      source: 'user-oauth',
      pr: {
        html_url: 'https://github.com/o/r/pull/22',
        title: 'GhostPR',
        head: null,
        base: 'main',
      },
      reviews: [],
      checks: [],
      comments: [],
      headSha: null,
    });
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app)
      .post('/api/projects/p/external-pr-review')
      .send({ prUrl: 'https://github.com/o/r/pull/22' });
    expect(res.status).toBe(202);
    expect(hoisted.dispatchReviewerForPR).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        prNumber: 22,
        headSha: undefined,
      }),
    );
  });
});
