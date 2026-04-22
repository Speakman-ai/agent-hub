import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';
import createPrNudgeReviewerRoutes from './pr-nudge-reviewer.js';

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
    },
    activeProcesses: new Map(),
    findProject: vi.fn(),
    ...overrides,
  } as unknown as RouteDeps;
}

function mount(deps: RouteDeps) {
  const app = express();
  app.use(express.json());
  app.use(createPrNudgeReviewerRoutes(deps));
  return app;
}

describe('POST /api/projects/:projectId/pulls/:number/nudge-reviewer', () => {
  beforeEach(async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockReset();
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      pr: { html_url: 'https://github.com/o/r/pull/3', title: 'T', head: { sha: 'abc' } },
      reviews: [],
      checks: [],
      comments: [],
    });
    hoisted.dispatchReviewerForPR.mockReset().mockReturnValue(true);
    hoisted.isReviewerDispatchPending.mockReset().mockReturnValue(false);
  });

  it('returns 404 when project is unknown', async () => {
    const app = mount(buildDeps({ findProject: vi.fn().mockReturnValue(null) }));
    const res = await request(app).post('/api/projects/ghost/pulls/1/nudge-reviewer');
    expect(res.status).toBe(404);
  });

  it('returns 400 when githubRepo is missing', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({ id: 'p', agents: [{ id: 'r', role: 'reviewer' }] }),
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/1/nudge-reviewer');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/githubRepo/);
  });

  it('returns 400 when no reviewer agent', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'lead', role: 'lead' }],
        }),
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/1/nudge-reviewer');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/reviewer/i);
  });

  it('returns 409 when a reviewer session is in flight for this PR', async () => {
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
        } as never,
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/5/nudge-reviewer');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still running/i);
    expect(res.body.activeSessionId).toBe('sess-busy');
  });

  it('returns 409 when dispatch is already debounced', async () => {
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
    const res = await request(app).post('/api/projects/p/pulls/2/nudge-reviewer');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/queued|debounce/i);
  });

  it('returns 202 and schedules dispatch on success', async () => {
    const app = mount(
      buildDeps({
        findProject: vi.fn().mockReturnValue({
          id: 'p',
          githubRepo: 'o/r',
          agents: [{ id: 'rev', role: 'reviewer' }],
        }),
      }),
    );
    const res = await request(app).post('/api/projects/p/pulls/3/nudge-reviewer');
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, scheduled: true });
    expect(hoisted.dispatchReviewerForPR).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'p' }),
      expect.objectContaining({
        prNumber: 3,
        reason: 'manual-nudge',
        repoFullName: 'o/r',
        headSha: 'abc',
      }),
    );
  });
});
