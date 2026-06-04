/**
 * Integration-level tests for the auth contract of pr-list.ts.
 *
 * After the "drop App fallbacks" refactor (PR #1069), the route
 * /api/projects/:id/pulls is user-OAuth ONLY:
 *   - present + working → 200 source:'user-oauth'
 *   - present + dead    → 502 (no App fallback)
 *   - missing           → 401 CONNECT_GITHUB_HINT
 *
 * These tests mock:
 *   - `../github-oauth.js` — so the user tier returns a controlled value
 *   - child_process/util — so the CLI tier is a no-op
 *
 * What they assert is the per-branch behaviour, not API shape — the
 * shape is covered by the pure-helper tests in pr-list.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

let TMP_DIR = '';
vi.mock('../config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const mockGithubUserApiRequest = vi.fn();
vi.mock('../github-oauth.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    githubUserApiRequest: (...args: unknown[]) => mockGithubUserApiRequest(...args),
  };
});

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, promisify: () => vi.fn() };
});

vi.mock('../pr-pull-list-enrichment.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    enrichPullListRowsWithGraphql: vi.fn().mockResolvedValue(undefined),
  };
});

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { upsertGithubConnection } = await import('../github-connections-store.js');
const createPrListRoutes = (await import('./pr-list.js')).default;

function freshEnv() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'pr-list-auth-chain-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  mockGithubUserApiRequest.mockReset();
}

function buildDeps(project: Record<string, unknown>): RouteDeps {
  return {
    config: { port: 3051 },
    findProject: vi.fn().mockImplementation((id: string) => (id === project.id ? project : null)),
  } as unknown as RouteDeps;
}

function makeApp(deps: RouteDeps, authUserId?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) (req as { authUserId?: string }).authUserId = authUserId;
    next();
  });
  app.use(createPrListRoutes(deps));
  return app;
}

describe('pr-list auth contract — user OAuth required (no App fallback)', () => {
  beforeEach(() => freshEnv());

  const project = { id: 'proj-1', githubRepo: 'speakman-ai/agent-hub' };

  it('uses user OAuth when the caller has a valid connection', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'user-access',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    mockGithubUserApiRequest.mockResolvedValueOnce([{ number: 1, title: 'hi', state: 'open' }]);

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('user-oauth');
    expect(mockGithubUserApiRequest).toHaveBeenCalledTimes(1);
  });

  it('returns 401 CONNECT_GITHUB_HINT when the caller has no user connection', async () => {
    // PR attribution is always the human at the keyboard. A user without
    // a stored connection gets a 401 that the client surfaces as a
    // "Connect GitHub" CTA.
    createUser({ username: 'alice', passwordHash: 'x' });

    const app = makeApp(buildDeps(project), 'some-user-without-connection');
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Connect your GitHub account/i);
    expect(mockGithubUserApiRequest).not.toHaveBeenCalled();
  });

  it('returns 502 when user OAuth throws at GitHub', async () => {
    // A dead user token surfaces the upstream error as a 502 so the user
    // can see it and re-connect their account. No silent identity swap.
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'user-access',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    mockGithubUserApiRequest.mockRejectedValueOnce(new Error('401 unauthorized'));

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Failed to list PRs/);
  });

  it('returns 401 on apiKey-path requests (no authUserId, no user-token resolution possible)', async () => {
    // No authUserId passed — mimics the apiKey path in the real auth
    // middleware. The apiKey path has no per-user identity to attribute
    // the request to, so /pulls returns 401.
    const app = makeApp(buildDeps(project));
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Connect your GitHub account/i);
    expect(mockGithubUserApiRequest).not.toHaveBeenCalled();
  });
});
