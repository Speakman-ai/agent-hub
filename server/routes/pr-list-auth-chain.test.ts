/**
 * Integration-level tests for the auth contract of pr-list.ts.
 *
 * After the "drop App fallbacks" refactor (PR #1069), the route
 * /api/projects/:id/pulls is user-OAuth ONLY:
 *   - present + working → 200 source:'user-oauth'
 *   - present + dead    → 502 (no App fallback)
 *   - missing           → 412 github_not_connected
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

  it('returns 412 github_not_connected when the caller has no user connection', async () => {
    // PR attribution is always the human at the keyboard. A user without a
    // stored connection gets a precondition failure the client surfaces as a
    // "Connect GitHub" CTA. It must NOT be 401: this route is polled on every
    // app load for each project with a githubRepo, and a dead-session status
    // here logged the user out in a loop.
    createUser({ username: 'alice', passwordHash: 'x' });

    const app = makeApp(buildDeps(project), 'some-user-without-connection');
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('github_not_connected');
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

  it('returns 412 github_not_connected on apiKey-path requests (no authUserId, no user-token resolution possible)', async () => {
    // No authUserId passed — mimics the apiKey path in the real auth
    // middleware. The apiKey path has no per-user identity to attribute
    // the request to, so there is no GitHub connection to resolve.
    const app = makeApp(buildDeps(project));
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('github_not_connected');
    expect(res.body.error).toMatch(/Connect your GitHub account/i);
    expect(mockGithubUserApiRequest).not.toHaveBeenCalled();
  });
});

describe('pr-list GitHub pagination — hasMore comes from the Link header', () => {
  beforeEach(() => freshEnv());

  const project = { id: 'proj-1', githubRepo: 'speakman-ai/agent-hub' };

  function connectedUser() {
    const user = createUser({
      username: `u-${Math.random().toString(36).slice(2)}`,
      passwordHash: 'x',
    });
    upsertGithubConnection({
      userId: user.id,
      login: 'speakmanra',
      accessToken: 'user-access',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      refreshToken: 'r',
      refreshExpiresAt: new Date(Date.now() + 180 * 24 * 3600 * 1000).toISOString(),
    });
    return user;
  }

  /** Reply with `count` PRs and the given Link header (undefined = no headers observable). */
  function respondWith(count: number, link?: string | null) {
    mockGithubUserApiRequest.mockImplementationOnce(
      async (opts: { onResponseHeaders?: (headers: Headers) => void }) => {
        if (link !== undefined) {
          opts.onResponseHeaders?.(new Headers(link ? { link } : {}));
        }
        return Array.from({ length: count }, (_, i) => ({
          number: i + 1,
          title: `PR ${i + 1}`,
          state: 'open',
        }));
      },
    );
  }

  it('forwards page and per_page to GitHub', async () => {
    const user = connectedUser();
    respondWith(2, null);

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls?limit=25&page=4');

    expect(res.status).toBe(200);
    expect(res.body.page).toBe(4);
    expect(res.body.limit).toBe(25);
    const { endpoint } = mockGithubUserApiRequest.mock.calls[0][0] as { endpoint: string };
    expect(endpoint).toContain('per_page=25');
    expect(endpoint).toContain('page=4');
  });

  it('reports another page when GitHub advertises rel="next"', async () => {
    const user = connectedUser();
    respondWith(2, '<https://api.github.com/repositories/1/pulls?page=2>; rel="next"');

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls?limit=2');
    expect(res.body.hasMore).toBe(true);
  });

  it('does NOT report another page when the final page is exactly full', async () => {
    // The regression: a length-only heuristic says "full page → more", which
    // sends the client to fetch an empty page 2.
    const user = connectedUser();
    respondWith(2, '<https://api.github.com/repositories/1/pulls?page=1>; rel="prev"');

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls?limit=2');
    expect(res.body.pulls).toHaveLength(2);
    expect(res.body.hasMore).toBe(false);
  });

  it('treats a Link-less response as a single page', async () => {
    const user = connectedUser();
    respondWith(2, null);

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls?limit=2');
    expect(res.body.hasMore).toBe(false);
  });

  it('falls back to the full-page guess when no headers are observable', async () => {
    const user = connectedUser();
    respondWith(2, undefined);

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls?limit=2');
    expect(res.body.hasMore).toBe(true);
  });
});
