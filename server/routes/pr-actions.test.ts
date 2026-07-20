import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Project, RouteDeps } from '../types.js';

function buildApp(
  overrides: Partial<RouteDeps> = {},
  preRouter?: express.RequestHandler,
): Promise<express.Express> {
  return (async () => {
    vi.resetModules();
    const { default: createPrActionRoutes } = await import('./pr-actions.js');
    const mockDeps = {
      config: { port: 3051, dataDir: '/tmp' },
      stmts: {},
      broadcast: vi.fn() as unknown,
      findProject: vi.fn(),
      findAgent: vi.fn(),
      getEnrichedAgent: vi.fn(),
      allAgents: vi.fn(),
      saveProjects: vi.fn(),
      handleChat: vi.fn(),
      lastDispatchedReviewId: new Map(),
      scheduleAutonomousEpic: vi.fn(),
      autonomousCrons: new Map(),
      runAutonomousLoop: vi.fn(),
      getProjects: vi.fn().mockReturnValue([]),
      setProjects: vi.fn(),
      serverDir: '/tmp',
      buildTranscript: vi.fn(),
      summarizeTranscript: vi.fn(),
      ...overrides,
    } as unknown as RouteDeps;
    const app = express();
    app.use(express.json());
    if (preRouter) app.use(preRouter);
    app.use(createPrActionRoutes(mockDeps));
    return app;
  })();
}

describe('PR Actions route', () => {
  describe('parsePrUrl (via route validation)', () => {
    let app: express.Express;
    beforeEach(async () => {
      app = await buildApp();
    });

    it('rejects invalid PR URL on merge', async () => {
      const res = await request(app).post('/api/pr/merge').send({ prUrl: 'not-a-url' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects invalid PR URL on close', async () => {
      const res = await request(app).post('/api/pr/close').send({ prUrl: '' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects missing prUrl on status', async () => {
      const res = await request(app).get('/api/pr/status');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects invalid prUrl query param on status', async () => {
      const res = await request(app).get('/api/pr/status?prUrl=garbage');
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });
  });

  describe('mergeMethod validation', () => {
    let app: express.Express;
    beforeEach(async () => {
      app = await buildApp();
    });

    it('rejects invalid merge method (command injection attempt)', async () => {
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: 'squash --admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid merge method/);
    });

    it('rejects arbitrary merge method strings', async () => {
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: 'foo' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid merge method/);
    });
  });

  describe('user-OAuth requirement on /api/pr/{merge,close,status}', () => {
    let app: express.Express;
    beforeEach(async () => {
      app = await buildApp();
    });

    it('/api/pr/merge returns 401 with CONNECT_GITHUB_HINT when no user OAuth token is resolved', async () => {
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Connect your GitHub account/i);
    });

    it('/api/pr/close returns 401 with CONNECT_GITHUB_HINT when no user OAuth token is resolved', async () => {
      const res = await request(app)
        .post('/api/pr/close')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Connect your GitHub account/i);
    });

    it('/api/pr/status returns 401 with CONNECT_GITHUB_HINT when no user OAuth token is resolved', async () => {
      const res = await request(app).get(
        '/api/pr/status?prUrl=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F42',
      );
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Connect your GitHub account/i);
    });
  });

  describe('POST /api/pr/auto-merge', () => {
    it('rejects a missing/non-boolean enabled flag', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/api/pr/auto-merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/enabled.*required/i);
    });

    it('rejects an invalid merge method', async () => {
      const app = await buildApp();
      const res = await request(app).post('/api/pr/auto-merge').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        enabled: true,
        mergeMethod: 'squash --admin',
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid merge method/);
    });

    it('rejects an invalid PR URL', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/api/pr/auto-merge')
        .send({ prUrl: 'not-a-url', enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects native (Agent Hub-hosted) PRs with a clear message', async () => {
      const app = await buildApp(
        {
          nativePr: { merge: vi.fn() } as never,
          findProject: vi.fn(() => ({ id: 'demo', gitHost: 'agenthub' })) as never,
        },
        // Bypass the visibility ACL (as an authenticated Owner/api-key caller would).
        (req, _res, next) => {
          (req as unknown as { authViaApiKey: boolean }).authViaApiKey = true;
          next();
        },
      );
      const res = await request(app)
        .post('/api/pr/auto-merge')
        .send({ prUrl: '/projects/demo/pulls/3', enabled: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not supported for Agent Hub-hosted PRs/i);
    });

    it('returns 401 with CONNECT_GITHUB_HINT when no user OAuth token is resolved', async () => {
      const app = await buildApp();
      const res = await request(app)
        .post('/api/pr/auto-merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', enabled: true });
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/Connect your GitHub account/i);
    });
  });

  describe('GitHub merge card metadata', () => {
    it('fetches PR metadata after merging before marking the linked card done', async () => {
      const calls: Array<{ endpoint: string; method?: string }> = [];
      const handleGithubCardOnMerge = vi.fn();

      vi.doMock('../github-oauth.js', () => ({
        githubUserApiRequest: vi.fn(
          async (args: { endpoint: string; method?: string; body?: unknown }) => {
            calls.push({ endpoint: args.endpoint, method: args.method });
            if (args.endpoint.endsWith('/merge')) return {};
            if (args.endpoint === '/repos/owner/repo/pulls/42') {
              return { title: 'Tracked card', head: { ref: 'agent-hub/dev/session-abcdef12' } };
            }
            if (args.endpoint.includes('/git/refs/heads/')) return {};
            throw new Error(`unexpected endpoint ${args.endpoint}`);
          },
        ),
      }));
      vi.doMock('./pr-list.js', () => ({
        resolveUserToken: vi.fn(async () => 'token-1'),
        parseRepoFullName: (value: string | null | undefined) => {
          if (!value) return null;
          const match = value.match(/^([^/]+)\/([^/]+)$/);
          return match ? { owner: match[1], repo: match[2] } : null;
        },
      }));
      vi.doMock('../github-card-on-merge.js', () => ({ handleGithubCardOnMerge }));

      const project = { id: 'proj-1', githubRepo: 'owner/repo' } as Project;
      const app = await buildApp({ getProjects: vi.fn(() => [project]) as never });

      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: 'squash' });

      expect(res.status).toBe(200);
      expect(calls[0]).toMatchObject({
        endpoint: '/repos/owner/repo/pulls/42/merge',
        method: 'PUT',
      });
      expect(calls[1]).toMatchObject({ endpoint: '/repos/owner/repo/pulls/42' });
      expect(handleGithubCardOnMerge).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          projectId: 'proj-1',
          prTitle: 'Tracked card',
          headRef: 'agent-hub/dev/session-abcdef12',
        }),
      );

      vi.doUnmock('../github-oauth.js');
      vi.doUnmock('./pr-list.js');
      vi.doUnmock('../github-card-on-merge.js');
    });
  });
});
