import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, mkdirSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

// Point orgs DB at a tmp dir that each test recreates.
let TMP_DIR = '';
vi.mock('../config.js', () => ({
  default: {
    apiKey: null,
    get dataDir() {
      return TMP_DIR;
    },
  },
}));

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { saveAuthRecord, setAuthFilePathForTests, reloadAuthRecord } =
  await import('../auth-store.js');
const { verifyJwt } = await import('../jwt.js');
const createGoogleOAuthRoutes = (await import('./google-oauth.js')).default;

const JWT_SECRET = 'test-secret-fixed-for-predictable-state-tokens-xxxxxxxx';

function freshEnv() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'google-oauth-routes-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  reloadAuthRecord();
  initOrgsDb();
  // Seed an auth record so getAuthRecord() returns a consistent jwtSecret.
  saveAuthRecord({
    username: 'owner',
    passwordHash: 'x',
    role: 'Owner',
    jwtSecret: JWT_SECRET,
    createdAt: new Date().toISOString(),
  });
  reloadAuthRecord();
}

function buildDeps(overrides: Record<string, unknown> = {}): RouteDeps {
  return {
    config: {
      port: 3051,
      publicUrl: 'https://hub.example.com',
      googleOAuth: {
        clientId: 'goog-client-id.apps.googleusercontent.com',
        clientSecret: 'goog-secret',
      },
      ...((overrides.config as object) || {}),
    },
  } as unknown as RouteDeps;
}

interface FakeAuth {
  authUserId?: string;
}

function makeApp(deps: RouteDeps, opts: FakeAuth = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as Request & FakeAuth;
    if (opts.authUserId) r.authUserId = opts.authUserId;
    next();
  });
  app.use(createGoogleOAuthRoutes(deps));
  return app;
}

describe('GET /api/auth/google/start', () => {
  beforeEach(() => freshEnv());

  it('503s with google_oauth_not_configured when no OAuth app is set', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps({ config: { googleOAuth: null } }), {
      authUserId: user.id,
    });
    const res = await request(app).get('/api/auth/google/start');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('google_oauth_not_configured');
  });

  it('503s (not 200) even before checking auth, so the connect UI degrades regardless of caller', async () => {
    const app = makeApp(buildDeps({ config: { googleOAuth: null } }));
    const res = await request(app).get('/api/auth/google/start');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('google_oauth_not_configured');
  });

  it('401s when configured but the caller is unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/google/start');
    expect(res.status).toBe(401);
  });

  it('returns a Google authorize URL with offline+consent and identity scopes when configured', async () => {
    const user = createUser({ username: 'bob', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/google/start');
    expect(res.status).toBe(200);

    const url = new URL(res.body.authorizeUrl);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('goog-client-id.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://hub.example.com/api/auth/google/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('scope')).toContain('openid');
    expect(url.searchParams.get('scope')).toContain('email');

    // State is a signed JWT carrying the user id under the google-oauth purpose.
    const state = url.searchParams.get('state')!;
    const verified = verifyJwt(state, JWT_SECRET);
    expect(verified.ok).toBe(true);
    expect(verified.payload).toBeDefined();
    expect((verified.payload as { purpose?: string }).purpose).toBe('google-oauth');
    expect(verified.payload?.sub).toBe(user.id);
  });

  it('merges extra incremental scopes from the scopes query param', async () => {
    const user = createUser({ username: 'carol', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app)
      .get('/api/auth/google/start')
      .query({ scopes: 'https://www.googleapis.com/auth/calendar.events' });
    expect(res.status).toBe(200);
    const scope = new URL(res.body.authorizeUrl).searchParams.get('scope')!;
    expect(scope).toContain('https://www.googleapis.com/auth/calendar.events');
    // Identity scopes are still present alongside the surface scope.
    expect(scope).toContain('openid');
  });
});
