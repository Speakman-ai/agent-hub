/**
 * Integration-level tests for the auth chain inversion in pr-list.ts.
 * Verifies user-OAuth tier is preferred over GitHub App tier.
 *
 * These tests mock:
 *   - `../github-app.js` — so the App tier doesn't reach out
 *   - `../github-oauth.js` — so the user tier returns a controlled value
 *   - child_process/util — so the CLI tier is a no-op
 *
 * What they assert is ordering, not API shape — the shape is covered by
 * the pure-helper tests in pr-list.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
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

const mockGithubApiRequest = vi.fn();
const mockResolveInstallationId = vi.fn();
vi.mock('../github-app.js', () => ({
  githubApiRequest: (...args: unknown[]) => mockGithubApiRequest(...args),
  resolveInstallationId: (...args: unknown[]) => mockResolveInstallationId(...args),
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

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { upsertGithubConnection } = await import('../github-connections-store.js');
const createPrListRoutes = (await import('./pr-list.js')).default;

function freshEnv() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'pr-list-auth-chain-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  mockGithubApiRequest.mockReset();
  mockResolveInstallationId.mockReset();
  mockGithubUserApiRequest.mockReset();
}

function buildDeps(project: Record<string, unknown>): RouteDeps {
  return {
    config: {
      port: 3051,
      githubApp: {
        appId: '1',
        privateKey: 'x',
        clientId: 'Iv1.abc',
        clientSecret: 'shh',
        installationId: 99,
      },
    },
    findProject: vi.fn().mockImplementation((id: string) => (id === project.id ? project : null)),
  } as unknown as RouteDeps;
}

function makeApp(deps: RouteDeps, authUserId?: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authUserId) (req as { authUserId?: string }).authUserId = authUserId;
    next();
  });
  app.use(createPrListRoutes(deps));
  return app;
}

describe('pr-list auth chain — user OAuth preferred over GitHub App', () => {
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
    expect(mockGithubApiRequest).not.toHaveBeenCalled();
  });

  it('falls back to GitHub App when the caller has no user connection', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    mockResolveInstallationId.mockReturnValue(99);
    mockGithubApiRequest.mockResolvedValueOnce([{ number: 2, title: 'from app', state: 'open' }]);

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('github-app');
    expect(mockGithubUserApiRequest).not.toHaveBeenCalled();
    expect(mockGithubApiRequest).toHaveBeenCalledTimes(1);
  });

  it('falls through to App tier when user OAuth throws (e.g. token dead at GitHub)', async () => {
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
    mockResolveInstallationId.mockReturnValue(99);
    mockGithubApiRequest.mockResolvedValueOnce([
      { number: 3, title: 'app fallback', state: 'open' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const app = makeApp(buildDeps(project), user.id);
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('github-app');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('skips user-tier entirely on apiKey-path requests (no authUserId)', async () => {
    mockResolveInstallationId.mockReturnValue(99);
    mockGithubApiRequest.mockResolvedValueOnce([{ number: 4, state: 'open' }]);

    // No authUserId passed — mimics the apiKey path in the real auth middleware.
    const app = makeApp(buildDeps(project));
    const res = await request(app).get('/api/projects/proj-1/pulls');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('github-app');
    expect(mockGithubUserApiRequest).not.toHaveBeenCalled();
  });
});
