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
        triggerReviewForCard: vi.fn(),
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
        triggerReviewForCard: vi.fn(),
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
});
