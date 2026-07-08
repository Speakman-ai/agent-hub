/**
 * Integration tests for the read-side PR proxy endpoints:
 *   GET /api/pr/data
 *   GET /api/pr/diff
 *   GET /api/pr/files
 *
 * These endpoints exist because reviewer-role spawns are intentionally
 * stripped of GitHub credentials (see `applyReviewerSpawnIsolation`). The
 * proxy lets the spawn fetch PR contents through server-side App / user-
 * OAuth creds without ever holding a token.
 *
 * Strategy: mock `fetchPrDetail`, `fetchPrDiff`, `fetchPrFiles` at the
 * helper layer so we drive the route shape (status codes, content types,
 * query-param parsing) without needing real GitHub credentials.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { RouteDeps } from '../types.js';

vi.mock('../pr-detail-fetch.js', () => ({
  fetchPrDetail: vi.fn(),
}));

vi.mock('../pr-read-fetch.js', () => ({
  fetchPrDiff: vi.fn(),
  fetchPrFiles: vi.fn(),
}));

vi.mock('./pr-list.js', () => ({
  resolveUserToken: vi.fn().mockResolvedValue(null),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFile: vi.fn(),
    exec: vi.fn((...args: unknown[]) => {
      const cb = args.find((a) => typeof a === 'function') as
        | ((err: unknown, stdout?: string, stderr?: string) => void)
        | undefined;
      if (cb) queueMicrotask(() => cb(null, '', ''));
      return {} as ReturnType<typeof actual.exec>;
    }),
  };
});
vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, promisify: () => vi.fn() };
});

function buildApp(): Promise<express.Express> {
  return import('./pr-actions.js').then(({ default: createPrActionRoutes }) => {
    const mockDeps = {
      config: { port: 3051, dataDir: '/tmp', botGithubToken: null },
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

    const app = express();
    app.use(express.json());
    app.use(createPrActionRoutes(mockDeps));
    return app;
  });
}

describe('GET /api/pr/diff', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.resetModules();
    app = await buildApp();
  });

  it('accepts ?prUrl and returns text/plain with the diff body', async () => {
    const { fetchPrDiff } = await import('../pr-read-fetch.js');
    (fetchPrDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      diff: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n',
    });

    const res = await request(app).get(
      '/api/pr/diff?prUrl=https://github.com/acme/webapp/pull/621',
    );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.headers['x-pr-source']).toBe('github-app');
    expect(res.text).toContain('diff --git a/x b/x');

    expect((fetchPrDiff as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
    expect((fetchPrDiff as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(621);
  });

  it('accepts ?owner=&repo=&number= as an alternative to prUrl', async () => {
    const { fetchPrDiff } = await import('../pr-read-fetch.js');
    (fetchPrDiff as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'user-oauth',
      diff: 'inline diff',
    });

    const res = await request(app).get('/api/pr/diff?owner=acme&repo=webapp&number=621');

    expect(res.status).toBe(200);
    expect(res.text).toBe('inline diff');
    expect((fetchPrDiff as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual({
      owner: 'acme',
      repo: 'webapp',
    });
    expect((fetchPrDiff as ReturnType<typeof vi.fn>).mock.calls[0][2]).toBe(621);
  });

  it('returns 400 on missing query', async () => {
    const res = await request(app).get('/api/pr/diff');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prUrl|owner/);
  });

  it('returns 400 on garbage prUrl', async () => {
    const res = await request(app).get('/api/pr/diff?prUrl=not-a-pr-url');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid PR URL/);
  });

  it('returns 400 when number is not numeric', async () => {
    const res = await request(app).get('/api/pr/diff?owner=o&repo=r&number=NaN');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/positive integer/);
  });

  it('returns 502 when the helper throws', async () => {
    const { fetchPrDiff } = await import('../pr-read-fetch.js');
    (fetchPrDiff as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('GitHub 404: PR not found'),
    );

    const res = await request(app).get('/api/pr/diff?prUrl=https://github.com/o/r/pull/1');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/PR diff fetch failed/);
    expect(res.body.error).toMatch(/GitHub 404/);
  });
});

describe('GET /api/pr/files', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.resetModules();
    app = await buildApp();
  });

  it('returns the files list JSON', async () => {
    const { fetchPrFiles } = await import('../pr-read-fetch.js');
    (fetchPrFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      truncated: false,
      files: [
        { filename: 'a.ts', status: 'modified', additions: 4, deletions: 2, changes: 6 },
        { filename: 'b.md', status: 'added', additions: 10, deletions: 0, changes: 10 },
      ],
    });

    const res = await request(app).get('/api/pr/files?prUrl=https://github.com/o/r/pull/9');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('github-app');
    expect(res.body.truncated).toBe(false);
    expect(res.body.files).toHaveLength(2);
    expect(res.body.count).toBe(2);
  });

  it('returns 400 on missing query', async () => {
    const res = await request(app).get('/api/pr/files');
    expect(res.status).toBe(400);
  });

  it('surfaces truncated=true to callers', async () => {
    const { fetchPrFiles } = await import('../pr-read-fetch.js');
    (fetchPrFiles as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      truncated: true,
      files: Array.from({ length: 3000 }, (_, i) => ({
        filename: `f${i}.ts`,
        status: 'modified',
        additions: 1,
        deletions: 0,
        changes: 1,
      })),
    });

    const res = await request(app).get('/api/pr/files?owner=o&repo=r&number=9');
    expect(res.status).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.count).toBe(3000);
  });
});

describe('GET /api/pr/data', () => {
  let app: express.Express;

  beforeEach(async () => {
    vi.resetModules();
    app = await buildApp();
  });

  it('returns the merged detail payload', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockResolvedValue({
      source: 'github-app',
      pr: { number: 621, title: 'feat(settings): add preview.py' },
      reviews: [],
      comments: [],
      checks: [],
    });

    const res = await request(app).get(
      '/api/pr/data?prUrl=https://github.com/acme/webapp/pull/621',
    );
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('github-app');
    expect(res.body.pr.number).toBe(621);
    expect(Array.isArray(res.body.reviews)).toBe(true);
    expect(Array.isArray(res.body.comments)).toBe(true);
    expect(Array.isArray(res.body.checks)).toBe(true);
  });

  it('returns 400 on garbage prUrl', async () => {
    const res = await request(app).get('/api/pr/data?prUrl=foo');
    expect(res.status).toBe(400);
  });

  it('returns 502 when the helper throws', async () => {
    const { fetchPrDetail } = await import('../pr-detail-fetch.js');
    (fetchPrDetail as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('upstream boom'));
    const res = await request(app).get('/api/pr/data?prUrl=https://github.com/o/r/pull/1');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/PR data fetch failed/);
  });
});
