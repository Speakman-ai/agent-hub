import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

function buildApp(): Promise<express.Express> {
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
    } as unknown as RouteDeps;
    const app = express();
    app.use(express.json());
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
});
