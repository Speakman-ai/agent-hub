import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

// Mock the GitHub App module
vi.mock('../github-app.js', () => ({
  githubApiRequest: vi.fn(),
  resolveInstallationId: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    promisify: (fn: unknown) => {
      // Return a mock async version of execFile
      return vi.fn();
    },
  };
});

// We test the parsePrUrl logic and route shape directly

describe('PR Actions route', () => {
  describe('parsePrUrl (via route validation)', () => {
    let app: express.Express;

    beforeEach(async () => {
      // Reset module cache to get fresh mocks
      vi.resetModules();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');

      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
        },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;

      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
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

    it('accepts valid GitHub PR URL format on merge (even if API fails)', async () => {
      // With no GitHub App and no gh CLI, it should attempt and fail
      const res = await request(app)
        .post('/api/pr/merge')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      // Should not be 400 (URL is valid) — might be 500 from CLI failure
      expect(res.status).not.toBe(400);
    });

    it('accepts valid GitHub PR URL format on close (even if API fails)', async () => {
      const res = await request(app)
        .post('/api/pr/close')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).not.toBe(400);
    });
  });

  describe('mergeMethod validation', () => {
    let app: express.Express;

    beforeEach(async () => {
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
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
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

    it('accepts squash, merge, and rebase methods', async () => {
      for (const method of ['squash', 'merge', 'rebase']) {
        const res = await request(app)
          .post('/api/pr/merge')
          .send({ prUrl: 'https://github.com/owner/repo/pull/42', mergeMethod: method });
        expect(res.status).not.toBe(400);
      }
    });
  });

  // ─── /api/pr/review ──────────────────────────────────────────────
  //
  // This endpoint exists because the reviewer/lead agent otherwise submits
  // reviews via `gh pr review`, which authenticates as the host's CLI identity
  // (usually the PR author). GitHub silently downgrades self-APPROVE to
  // COMMENTED. Routing reviews through the GitHub App installation gives the
  // review a distinct identity so self-approval works.

  describe('/api/pr/review — validation', () => {
    let app: express.Express;

    beforeEach(async () => {
      vi.resetModules();
      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: { port: 3051, dataDir: '/tmp', botGithubToken: null, githubApp: null },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('rejects invalid PR URL', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'not-a-url', event: 'APPROVE' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid PR URL/);
    });

    it('rejects missing event', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid review event/);
    });

    it('rejects bogus event values (guards against command injection / typos)', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE; rm -rf' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid review event/);
    });

    it('accepts APPROVE, REQUEST_CHANGES, COMMENT (body required for the latter two)', async () => {
      // APPROVE without body is valid
      const approveRes = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE' });
      // Will 501 because no App/bot token configured, but event validation passed
      expect(approveRes.status).not.toBe(400);

      // REQUEST_CHANGES without body is rejected at validation
      const rcNoBody = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'REQUEST_CHANGES' });
      expect(rcNoBody.status).toBe(400);
      expect(rcNoBody.body.error).toMatch(/body is required/);

      // COMMENT without body is rejected at validation
      const commentNoBody = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'COMMENT' });
      expect(commentNoBody.status).toBe(400);

      // COMMENT with body passes validation
      const commentOk = await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'COMMENT',
        body: 'notes',
      });
      expect(commentOk.status).not.toBe(400);
    });

    it('returns 501 when no GitHub App installation and no bot token are configured', async () => {
      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE' });
      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/No GitHub App installation/);
    });
  });

  describe('/api/pr/review — GitHub App path', () => {
    let app: express.Express;
    let githubApiRequest: ReturnType<typeof vi.fn>;
    let resolveInstallationId: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.resetModules();
      const mod = await import('../github-app.js');
      githubApiRequest = mod.githubApiRequest as unknown as ReturnType<typeof vi.fn>;
      resolveInstallationId = mod.resolveInstallationId as unknown as ReturnType<typeof vi.fn>;
      githubApiRequest.mockReset();
      resolveInstallationId.mockReset();

      const { default: createPrActionRoutes } = await import('./pr-actions.js');
      const mockDeps = {
        config: {
          port: 3051,
          dataDir: '/tmp',
          botGithubToken: null,
          githubApp: {
            appId: '1',
            privateKey: 'key',
            installationId: 42,
            installations: [{ id: 42, account: 'owner', accountType: 'Organization' }],
          },
        },
        stmts: {},
        broadcast: vi.fn() as unknown,
        findProject: vi.fn(),
        findAgent: vi.fn(),
        getEnrichedAgent: vi.fn(),
        allAgents: vi.fn(),
        saveProjects: vi.fn(),
        ensureProjectRoom: vi.fn(),
        handleChat: vi.fn(),
        pendingReviewComments: new Map(),
        lastDispatchedReviewId: new Map(),
        scheduleAutonomousEpic: vi.fn(),
        autonomousCrons: new Map(),
        runAutonomousLoop: vi.fn(),
        getProjects: vi.fn().mockReturnValue([]),
        setProjects: vi.fn(),
        getGhBotUser: vi.fn().mockReturnValue(null),
        setGhBotUser: vi.fn(),
        getGhAppSlug: vi.fn().mockReturnValue(null),
        setGhAppSlug: vi.fn(),
        serverDir: '/tmp',
        buildTranscript: vi.fn(),
        summarizeTranscript: vi.fn(),
      } as unknown as RouteDeps;
      app = express();
      app.use(express.json());
      app.use(createPrActionRoutes(mockDeps));
    });

    it('submits the review via githubApiRequest with event + App credentials', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({
        id: 99,
        html_url: 'https://github.com/owner/repo/pull/42#review-99',
        user: { login: 'ryan-s-agent-hub-reviewer[bot]' },
        state: 'APPROVED',
      });

      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        method: 'github-app',
        pr: '42',
        event: 'APPROVE',
        reviewId: 99,
        reviewer: 'ryan-s-agent-hub-reviewer[bot]',
      });

      expect(githubApiRequest).toHaveBeenCalledTimes(1);
      const [endpoint, opts] = githubApiRequest.mock.calls[0];
      expect(endpoint).toBe('/repos/owner/repo/pulls/42/reviews');
      expect(opts).toMatchObject({
        method: 'POST',
        body: { event: 'APPROVE' },
        appId: '1',
        installationId: 42,
      });
    });

    it('forwards body + commit_id when provided', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockResolvedValue({ id: 100, state: 'CHANGES_REQUESTED' });

      await request(app).post('/api/pr/review').send({
        prUrl: 'https://github.com/owner/repo/pull/42',
        event: 'REQUEST_CHANGES',
        body: 'Please fix the missing null check.',
        commitId: 'abc123',
      });

      const [, opts] = githubApiRequest.mock.calls[0];
      expect(opts.body).toMatchObject({
        event: 'REQUEST_CHANGES',
        body: 'Please fix the missing null check.',
        commit_id: 'abc123',
      });
    });

    it('falls back to 501 when the App path throws and no bot token is configured', async () => {
      resolveInstallationId.mockReturnValue(42);
      githubApiRequest.mockRejectedValue(new Error('GitHub API POST failed (403): forbidden'));

      const res = await request(app)
        .post('/api/pr/review')
        .send({ prUrl: 'https://github.com/owner/repo/pull/42', event: 'APPROVE' });

      expect(res.status).toBe(501);
      expect(res.body.error).toMatch(/No GitHub App installation|bot token/);
    });
  });
});
