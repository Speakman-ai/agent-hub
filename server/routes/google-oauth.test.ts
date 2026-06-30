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

// Mock the network-touching Google OAuth helpers (code exchange, userinfo,
// revoke) while keeping the pure helpers (buildAuthorizeUrl,
// resolveGoogleRedirectUri) real. This is the "googleapis mocked" seam: no
// real Google HTTP calls happen in tests.
vi.mock('../google-oauth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../google-oauth.js')>();
  return {
    ...actual,
    exchangeCodeForGoogleTokens: vi.fn(),
    fetchGoogleUserInfo: vi.fn(),
    revokeGoogleToken: vi.fn(),
  };
});

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { saveAuthRecord, setAuthFilePathForTests, reloadAuthRecord } =
  await import('../auth-store.js');
const { signJwt, verifyJwt } = await import('../jwt.js');
const { getGoogleConnection, upsertGoogleConnection } =
  await import('../google-connections-store.js');
const googleOAuth = await import('../google-oauth.js');
const exchangeMock = vi.mocked(googleOAuth.exchangeCodeForGoogleTokens);
const userInfoMock = vi.mocked(googleOAuth.fetchGoogleUserInfo);
const revokeMock = vi.mocked(googleOAuth.revokeGoogleToken);
const createGoogleOAuthRoutes = (await import('./google-oauth.js')).default;

const STATE_PURPOSE = 'google-oauth';

function mintState(uid: string, opts: { purpose?: string; returnTo?: string } = {}): string {
  return signJwt(uid, JWT_SECRET, {
    expiresInSec: 600,
    claims: {
      purpose: opts.purpose ?? STATE_PURPOSE,
      ...(opts.returnTo && { returnTo: opts.returnTo }),
    },
  });
}

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

  it('signs a safe relative returnTo into the state but drops off-site values', async () => {
    const user = createUser({ username: 'nina', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });

    const safe = await request(app)
      .get('/api/auth/google/start')
      .query({ returnTo: '/settings/account' });
    const safeState = new URL(safe.body.authorizeUrl).searchParams.get('state')!;
    expect((verifyJwt(safeState, JWT_SECRET).payload as { returnTo?: string }).returnTo).toBe(
      '/settings/account',
    );

    for (const evil of ['//evil.com', '/\\evil.com', 'https://evil.com']) {
      const res = await request(app).get('/api/auth/google/start').query({ returnTo: evil });
      const state = new URL(res.body.authorizeUrl).searchParams.get('state')!;
      // The open-redirect candidate is never carried into the signed state.
      expect(
        (verifyJwt(state, JWT_SECRET).payload as { returnTo?: string }).returnTo,
      ).toBeUndefined();
    }
  });
});

describe('GET /api/auth/google/callback', () => {
  beforeEach(() => {
    freshEnv();
    exchangeMock.mockReset();
    userInfoMock.mockReset();
  });

  it('rejects a missing code or state with 400', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/google/callback').query({ code: 'abc' });
    expect(res.status).toBe(400);
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('surfaces a Google error param as a 400 status page', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ error: 'access_denied' });
    expect(res.status).toBe(400);
    expect(res.text).toContain('access_denied');
  });

  it('rejects a state token minted for a different purpose', async () => {
    const user = createUser({ username: 'dora', passwordHash: 'x' });
    const app = makeApp(buildDeps());
    const state = mintState(user.id, { purpose: 'github-oauth' });
    const res = await request(app).get('/api/auth/google/callback').query({ code: 'abc', state });
    expect(res.status).toBe(400);
    expect(res.text).toContain('not issued for Google sign-in');
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('rejects a state token signed with the wrong secret', async () => {
    const user = createUser({ username: 'evan', passwordHash: 'x' });
    const app = makeApp(buildDeps());
    const forged = signJwt(user.id, 'a-totally-different-secret-aaaaaaaaaaaaaaaaaaaa', {
      expiresInSec: 600,
      claims: { purpose: STATE_PURPOSE },
    });
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'abc', state: forged });
    expect(res.status).toBe(400);
    expect(res.text).toContain('Invalid state token');
    expect(exchangeMock).not.toHaveBeenCalled();
  });

  it('happy path: exchanges code, persists an encrypted connection, redirects', async () => {
    const user = createUser({ username: 'frank', passwordHash: 'x' });
    exchangeMock.mockResolvedValue({
      access_token: 'ya29.access-token',
      expires_in: 3600,
      refresh_token: 'refresh-token-123',
      scope: 'openid email https://www.googleapis.com/auth/calendar.events',
      token_type: 'Bearer',
    });
    userInfoMock.mockResolvedValue({
      sub: 'google-sub-999',
      email: 'frank@example.com',
      email_verified: true,
      name: 'Frank',
      picture: null,
    });

    const app = makeApp(buildDeps());
    const state = mintState(user.id, { returnTo: '/settings/account' });
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'auth-code-abc', state });

    expect(res.status).toBe(200);
    expect(res.text).toContain('frank@example.com');
    // Redirect back to the validated returnTo.
    expect(res.text).toContain('url=/settings/account');
    expect(exchangeMock).toHaveBeenCalledTimes(1);

    // Connection persisted with decrypted tokens + parsed scopes.
    const conn = getGoogleConnection(user.id);
    expect(conn).not.toBeNull();
    expect(conn?.googleSub).toBe('google-sub-999');
    expect(conn?.googleEmail).toBe('frank@example.com');
    expect(conn?.accessToken).toBe('ya29.access-token');
    expect(conn?.refreshToken).toBe('refresh-token-123');
    expect(conn?.grantedScopes).toContain('https://www.googleapis.com/auth/calendar.events');
  });

  it.each(['//evil.com', '/\\evil.com', '\\/evil.com', 'https://evil.com', 'evil.com'])(
    'coerces an off-site returnTo (%s) in the signed state to the app root',
    async (evil) => {
      const user = createUser({
        username: `redir-${Buffer.from(evil).toString('hex')}`,
        passwordHash: 'x',
      });
      exchangeMock.mockResolvedValue({
        access_token: 'a',
        expires_in: 3600,
        refresh_token: 'r',
        scope: 'openid email',
        token_type: 'Bearer',
      });
      userInfoMock.mockResolvedValue({ sub: 'sub-redir', email: 'redir@example.com' });

      const app = makeApp(buildDeps());
      // Mint a state directly carrying the malicious returnTo to exercise the
      // callback's defense-in-depth guard (a forged/old state could carry it).
      const state = mintState(user.id, { returnTo: evil });
      const res = await request(app)
        .get('/api/auth/google/callback')
        .query({ code: 'code', state });

      expect(res.status).toBe(200);
      // The meta-refresh must point at the app root, never the off-site value.
      expect(res.text).toContain('url=/"');
      expect(res.text).not.toContain('evil.com');
    },
  );

  it('preserves the existing refresh token when a re-consent omits one', async () => {
    const user = createUser({ username: 'gina', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 'google-sub-gina',
      googleEmail: 'gina@example.com',
      accessToken: 'old-access',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: 'original-refresh',
      grantedScopes: ['openid'],
    });
    exchangeMock.mockResolvedValue({
      access_token: 'new-access',
      expires_in: 3600,
      // No refresh_token on this incremental re-consent.
      scope: 'openid email',
      token_type: 'Bearer',
    });
    userInfoMock.mockResolvedValue({ sub: 'google-sub-gina', email: 'gina@example.com' });

    const app = makeApp(buildDeps());
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'code2', state: mintState(user.id) });
    expect(res.status).toBe(200);
    const conn = getGoogleConnection(user.id);
    expect(conn?.accessToken).toBe('new-access');
    expect(conn?.refreshToken).toBe('original-refresh');
  });

  it('renders a 502 status page when the token exchange throws', async () => {
    const user = createUser({ username: 'hank', passwordHash: 'x' });
    exchangeMock.mockRejectedValue(new Error('Google OAuth token exchange failed (400): bad_code'));
    const app = makeApp(buildDeps());
    const res = await request(app)
      .get('/api/auth/google/callback')
      .query({ code: 'bad', state: mintState(user.id) });
    expect(res.status).toBe(502);
    expect(res.text).toContain('Google connection failed');
    expect(getGoogleConnection(user.id)).toBeNull();
  });
});

describe('GET /api/auth/google/status', () => {
  beforeEach(() => freshEnv());

  it('401s when the caller is unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/google/status');
    expect(res.status).toBe(401);
  });

  it('reports not-connected with serverConfigured=true and no tokens', async () => {
    const user = createUser({ username: 'iris', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/google/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      connected: false,
      email: null,
      grantedScopes: [],
      connectedAt: null,
      tokenExpiresAt: null,
      serverConfigured: true,
    });
    // Defense-in-depth: the status payload exposes only the field names above —
    // no access/refresh token material.
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it('reports connected with email + scopes (never tokens) once linked', async () => {
    const user = createUser({ username: 'jack', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 'sub-jack',
      googleEmail: 'jack@example.com',
      accessToken: 'secret-access',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: 'secret-refresh',
      grantedScopes: ['openid', 'email'],
    });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/google/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.email).toBe('jack@example.com');
    expect(res.body.grantedScopes).toEqual(['openid', 'email']);
    expect(res.body.serverConfigured).toBe(true);
    // No raw token values leak into the status response.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('secret-access');
    expect(serialized).not.toContain('secret-refresh');
  });

  it('reports serverConfigured=false when no OAuth app is set', async () => {
    const user = createUser({ username: 'kara', passwordHash: 'x' });
    const app = makeApp(buildDeps({ config: { googleOAuth: null } }), { authUserId: user.id });
    const res = await request(app).get('/api/auth/google/status');
    expect(res.status).toBe(200);
    expect(res.body.serverConfigured).toBe(false);
  });
});

describe('DELETE /api/auth/google/connect', () => {
  beforeEach(() => {
    freshEnv();
    revokeMock.mockReset();
    revokeMock.mockResolvedValue(true);
  });

  it('401s when the caller is unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).delete('/api/auth/google/connect');
    expect(res.status).toBe(401);
  });

  it('revokes the refresh token and clears the connection row', async () => {
    const user = createUser({ username: 'liam', passwordHash: 'x' });
    upsertGoogleConnection({
      userId: user.id,
      googleSub: 'sub-liam',
      googleEmail: 'liam@example.com',
      accessToken: 'access-liam',
      tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      refreshToken: 'refresh-liam',
      grantedScopes: ['openid'],
    });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).delete('/api/auth/google/connect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(revokeMock).toHaveBeenCalledWith({ token: 'refresh-liam' });
    expect(getGoogleConnection(user.id)).toBeNull();
  });

  it('is idempotent when there is no connection (no revoke call)', async () => {
    const user = createUser({ username: 'mara', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).delete('/api/auth/google/connect');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(revokeMock).not.toHaveBeenCalled();
  });
});
