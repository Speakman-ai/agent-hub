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

// Mock the github-oauth module's network calls so tests never hit GitHub.
const mockExchange = vi.fn();
const mockFetchUser = vi.fn();
vi.mock('../github-oauth.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    exchangeCodeForToken: (...args: unknown[]) => mockExchange(...args),
    fetchUserInfo: (...args: unknown[]) => mockFetchUser(...args),
  };
});

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { saveAuthRecord, setAuthFilePathForTests, reloadAuthRecord } =
  await import('../auth-store.js');
const { signJwt } = await import('../jwt.js');
const createGithubOAuthRoutes = (await import('./github-oauth.js')).default;
const { getGithubConnection } = await import('../github-connections-store.js');

const JWT_SECRET = 'test-secret-fixed-for-predictable-state-tokens-xxxxxxxx';

function freshEnv() {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'gh-oauth-routes-test-'));
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
  mockExchange.mockReset();
  mockFetchUser.mockReset();
}

function buildDeps(overrides: Record<string, unknown> = {}): RouteDeps {
  return {
    config: {
      port: 3051,
      publicUrl: 'https://hub.example.com',
      githubApp: {
        appId: '1',
        privateKey: 'x',
        clientId: 'Iv1.abc',
        clientSecret: 'shh',
      },
      ...((overrides.config as object) || {}),
    },
  } as unknown as RouteDeps;
}

interface FakeAuth {
  authUserId?: string;
  authLocalOrgBypass?: boolean;
  authOrgId?: string;
  authViaApiKey?: boolean;
}

function makeApp(deps: RouteDeps, opts: FakeAuth = {}): express.Express {
  const app = express();
  app.use(express.json());
  // Inject fake auth state — mirrors what the real auth middleware does
  // on a successful JWT verification (sets `authUserId`) or on the
  // local-mode org bypass (sets `authLocalOrgBypass` + `authOrgId`).
  // Public paths (callback) don't rely on this, so we conditionally set
  // each field.
  app.use((req, _res, next) => {
    const r = req as Request & FakeAuth;
    if (opts.authUserId) r.authUserId = opts.authUserId;
    if (opts.authLocalOrgBypass) r.authLocalOrgBypass = true;
    if (opts.authOrgId) r.authOrgId = opts.authOrgId;
    if (opts.authViaApiKey) r.authViaApiKey = true;
    next();
  });
  app.use(createGithubOAuthRoutes(deps));
  return app;
}

describe('GET /api/auth/github/start', () => {
  beforeEach(() => freshEnv());

  it('401s when the caller is unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(401);
  });

  it('401s when the caller is apiKey-only (no personal user identity)', async () => {
    // The break-glass apiKey is shared across machines/sub-agents, so the
    // route refuses to bind a personal GitHub identity to it.
    const app = makeApp(buildDeps(), { authViaApiKey: true });
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(401);
  });

  it('503s when GitHub OAuth credentials are missing', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps({ config: { githubApp: null } }), {
      authUserId: user.id,
    });
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('github_oauth_not_configured');
  });

  it('rejects protocol-relative returnTo (//evil.com) at mint time', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/github/start?returnTo=//evil.com/phish');
    expect(res.status).toBe(200);
    const url = new URL(res.body.authorizeUrl);
    const stateToken = url.searchParams.get('state')!;
    const [, payloadB64] = stateToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    // The protocol-relative path must have been stripped from the signed state.
    expect(payload.returnTo).toBeUndefined();
  });

  it('returns a signed-state authorize URL for an authenticated caller', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(200);
    expect(res.body.authorizeUrl).toContain('https://github.com/login/oauth/authorize');
    const url = new URL(res.body.authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('Iv1.abc');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://hub.example.com/api/auth/github/callback',
    );
    // State is a signed JWT — decode and assert it binds to the user id.
    const stateToken = url.searchParams.get('state')!;
    const [, payloadB64] = stateToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    expect(payload.sub).toBe(user.id);
    expect(payload.purpose).toBe('github-oauth');
  });

  it('lazily provisions a synthetic local user when the active org is local-mode', async () => {
    // Local-mode org bypass: middleware sets authLocalOrgBypass + authOrgId
    // but no authUserId. Pre-fix: route 401s. Post-fix: get-or-create a
    // deterministic `local-<orgId>` user row and bind the OAuth state to it.
    const { getUserByUsername: getU } = await import('../users-store.js');
    expect(getU('local-default')).toBeNull();

    const app = makeApp(buildDeps(), {
      authLocalOrgBypass: true,
      authOrgId: 'default',
    });
    const res = await request(app).get('/api/auth/github/start');
    expect(res.status).toBe(200);

    const created = getU('local-default');
    expect(created).not.toBeNull();

    // State JWT must bind to the synthetic user's id so the callback
    // persists tokens against the same row on the round-trip.
    const url = new URL(res.body.authorizeUrl);
    const stateToken = url.searchParams.get('state')!;
    const [, payloadB64] = stateToken.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    expect(payload.sub).toBe(created!.id);
    expect(payload.purpose).toBe('github-oauth');
  });

  it('reuses the synthetic local user across requests (idempotent provisioning)', async () => {
    const { getUserByUsername: getU } = await import('../users-store.js');
    const app = makeApp(buildDeps(), {
      authLocalOrgBypass: true,
      authOrgId: 'default',
    });
    const res1 = await request(app).get('/api/auth/github/start');
    const res2 = await request(app).get('/api/auth/github/start');
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    const id1 = JSON.parse(
      Buffer.from(
        new URL(res1.body.authorizeUrl).searchParams.get('state')!.split('.')[1],
        'base64',
      ).toString('utf8'),
    ).sub;
    const id2 = JSON.parse(
      Buffer.from(
        new URL(res2.body.authorizeUrl).searchParams.get('state')!.split('.')[1],
        'base64',
      ).toString('utf8'),
    ).sub;
    expect(id1).toBe(id2);
    expect(getU('local-default')!.id).toBe(id1);
  });
});

describe('GET /api/auth/github/callback', () => {
  beforeEach(() => freshEnv());

  it('400s when state is missing', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/github/callback?code=abc');
    expect(res.status).toBe(400);
  });

  it('400s when state is forged (bad signature)', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/github/callback?code=abc&state=totally.made.up');
    expect(res.status).toBe(400);
    expect(res.text).toContain('state');
  });

  it('400s when state has wrong purpose', async () => {
    const app = makeApp(buildDeps());
    const wrongPurpose = signJwt('user-1', JWT_SECRET, {
      claims: { purpose: 'not-github-oauth' },
    });
    const res = await request(app).get(`/api/auth/github/callback?code=abc&state=${wrongPurpose}`);
    expect(res.status).toBe(400);
  });

  it('exchanges code, fetches user info, persists connection, and returns HTML', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const state = signJwt(user.id, JWT_SECRET, {
      claims: { purpose: 'github-oauth' },
    });
    mockExchange.mockResolvedValueOnce({
      access_token: 'ghu_123',
      refresh_token: 'ghr_abc',
      expires_in: 28800,
      refresh_token_expires_in: 15724800,
      token_type: 'bearer',
      scope: '',
    });
    mockFetchUser.mockResolvedValueOnce({
      id: 42,
      login: 'speakmanra',
      name: null,
      avatar_url: null,
      email: null,
    });

    const app = makeApp(buildDeps());
    const res = await request(app).get(`/api/auth/github/callback?code=real-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connected as @speakmanra');
    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockFetchUser).toHaveBeenCalledTimes(1);

    const stored = getGithubConnection(user.id);
    expect(stored?.login).toBe('speakmanra');
    expect(stored?.accessToken).toBe('ghu_123');
    expect(stored?.refreshToken).toBe('ghr_abc');
  });

  // Regression: classic OAuth Apps (registered at /settings/applications/new)
  // and GitHub Apps without "Expire user authorization tokens" return only
  // `access_token`/`scope`/`token_type`. Before the fix, the callback would
  // crash on `tokens.refresh_token_expires_in * 1000` → "Invalid Date" and
  // the user would land on the "GitHub OAuth response missing access_token
  // or refresh_token" error page. Now the connection persists with null
  // expiry / null refresh columns.
  it('persists null expiry and null refresh for a non-expiring OAuth client', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const state = signJwt(user.id, JWT_SECRET, {
      claims: { purpose: 'github-oauth' },
    });
    mockExchange.mockResolvedValueOnce({
      access_token: 'gho_no_expiry',
      token_type: 'bearer',
      scope: 'repo',
      // No expires_in, no refresh_token, no refresh_token_expires_in.
    });
    mockFetchUser.mockResolvedValueOnce({
      id: 99,
      login: 'speakmanra',
      name: null,
      avatar_url: null,
      email: null,
    });

    const app = makeApp(buildDeps());
    const res = await request(app).get(`/api/auth/github/callback?code=real-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Connected as @speakmanra');

    const stored = getGithubConnection(user.id);
    expect(stored?.accessToken).toBe('gho_no_expiry');
    expect(stored?.tokenExpiresAt).toBeNull();
    expect(stored?.refreshToken).toBeNull();
    expect(stored?.refreshExpiresAt).toBeNull();
  });

  it('rejects returnTo that is an absolute URL (open-redirect guard)', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    // Even if somehow minted, an absolute returnTo should be ignored by
    // the callback — it only uses `/`-prefixed paths.
    const state = signJwt(user.id, JWT_SECRET, {
      claims: { purpose: 'github-oauth', returnTo: 'https://evil.example.com/steal' },
    });
    mockExchange.mockResolvedValueOnce({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 28800,
      refresh_token_expires_in: 15724800,
      token_type: 'bearer',
      scope: '',
    });
    mockFetchUser.mockResolvedValueOnce({
      id: 1,
      login: 'u',
      name: null,
      avatar_url: null,
      email: null,
    });
    const app = makeApp(buildDeps());
    const res = await request(app).get(`/api/auth/github/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    // Defense-in-depth: callback now re-validates returnTo and falls back to '/'
    expect(res.text).not.toContain('evil.example.com');
    expect(res.text).toContain('url=/');
  });

  it('rejects protocol-relative returnTo (//evil.com) in callback (defense-in-depth)', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    // Simulate a state that somehow carries a protocol-relative returnTo.
    const state = signJwt(user.id, JWT_SECRET, {
      claims: { purpose: 'github-oauth', returnTo: '//evil.com/phish' },
    });
    mockExchange.mockResolvedValueOnce({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 28800,
      refresh_token_expires_in: 15724800,
      token_type: 'bearer',
      scope: '',
    });
    mockFetchUser.mockResolvedValueOnce({
      id: 1,
      login: 'u',
      name: null,
      avatar_url: null,
      email: null,
    });
    const app = makeApp(buildDeps());
    const res = await request(app).get(`/api/auth/github/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    // The protocol-relative URL must NOT appear in the redirect meta tag.
    expect(res.text).not.toContain('//evil.com');
    expect(res.text).toContain('url=/');
  });

  it('HTML-escapes the error query param to prevent reflected XSS', async () => {
    const app = makeApp(buildDeps());
    const xssPayload = '<script>alert(1)</script>';
    const res = await request(app).get(
      `/api/auth/github/callback?error=${encodeURIComponent(xssPayload)}`,
    );
    expect(res.status).toBe(400);
    // The raw <script> tag must NOT appear in the response.
    expect(res.text).not.toContain('<script>');
    // The escaped form should be present.
    expect(res.text).toContain('&lt;script&gt;');
  });

  it('sets a restrictive CSP header on callback responses', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/github/callback?error=test');
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
  });
});

describe('GET /api/auth/github/status', () => {
  beforeEach(() => freshEnv());

  it('401s when unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).get('/api/auth/github/status');
    expect(res.status).toBe(401);
  });

  it('reports disconnected state for a user with no link', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).get('/api/auth/github/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.login).toBeNull();
    expect(res.body.serverConfigured).toBe(true);
  });

  it('reports serverConfigured=false when OAuth creds are missing', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps({ config: { githubApp: null } }), {
      authUserId: user.id,
    });
    const res = await request(app).get('/api/auth/github/status');
    expect(res.status).toBe(200);
    expect(res.body.serverConfigured).toBe(false);
  });

  it('returns disconnected status (200) under local-org bypass without 401', async () => {
    const app = makeApp(buildDeps(), {
      authLocalOrgBypass: true,
      authOrgId: 'default',
    });
    const res = await request(app).get('/api/auth/github/status');
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
  });
});

describe('DELETE /api/auth/github', () => {
  beforeEach(() => freshEnv());

  it('401s when unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app).delete('/api/auth/github');
    expect(res.status).toBe(401);
  });

  it("clears the caller's connection and is idempotent", async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    // Seed via callback flow
    const state = signJwt(user.id, JWT_SECRET, {
      claims: { purpose: 'github-oauth' },
    });
    mockExchange.mockResolvedValueOnce({
      access_token: 'a',
      refresh_token: 'r',
      expires_in: 28800,
      refresh_token_expires_in: 15724800,
      token_type: 'bearer',
      scope: '',
    });
    mockFetchUser.mockResolvedValueOnce({
      id: 1,
      login: 'speakmanra',
      name: null,
      avatar_url: null,
      email: null,
    });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    await request(app).get(`/api/auth/github/callback?code=c&state=${state}`);
    expect(getGithubConnection(user.id)).not.toBeNull();

    const res1 = await request(app).delete('/api/auth/github');
    expect(res1.status).toBe(200);
    expect(getGithubConnection(user.id)).toBeNull();

    const res2 = await request(app).delete('/api/auth/github');
    expect(res2.status).toBe(200);
  });

  it('succeeds (200) under local-org bypass even when no connection exists', async () => {
    const app = makeApp(buildDeps(), {
      authLocalOrgBypass: true,
      authOrgId: 'default',
    });
    const res = await request(app).delete('/api/auth/github');
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/github/connect-token', () => {
  beforeEach(() => freshEnv());

  it('401s when unauthenticated', async () => {
    const app = makeApp(buildDeps());
    const res = await request(app)
      .post('/api/auth/github/connect-token')
      .send({ token: 'ghp_xxx' });
    expect(res.status).toBe(401);
  });

  it('400s when token is missing', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).post('/api/auth/github/connect-token').send({});
    expect(res.status).toBe(400);
  });

  it('400s when token is empty string', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app).post('/api/auth/github/connect-token').send({ token: '   ' });
    expect(res.status).toBe(400);
  });

  it('persists the PAT under the caller and returns the login', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    mockFetchUser.mockResolvedValueOnce({
      id: 7,
      login: 'speakmanra',
      name: null,
      avatar_url: null,
      email: null,
    });
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app)
      .post('/api/auth/github/connect-token')
      .send({ token: 'ghp_realPAT' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, login: 'speakmanra' });

    const stored = getGithubConnection(user.id);
    expect(stored?.login).toBe('speakmanra');
    expect(stored?.accessToken).toBe('ghp_realPAT');
    // PATs use a far-future expiry — must be > now + a year so the active
    // token resolver returns it directly without trying to refresh.
    expect(stored!.tokenExpiresAt).not.toBeNull();
    expect(Date.parse(stored!.tokenExpiresAt!) - Date.now()).toBeGreaterThan(
      365 * 24 * 60 * 60 * 1000,
    );
  });

  it('returns 400 with a friendly message when GitHub rejects the token', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    mockFetchUser.mockRejectedValueOnce(
      new Error('GitHub /user fetch failed (401): Bad credentials'),
    );
    const app = makeApp(buildDeps(), { authUserId: user.id });
    const res = await request(app)
      .post('/api/auth/github/connect-token')
      .send({ token: 'ghp_bogus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid github token/i);
  });

  it('works under local-org bypass (lazily provisions the synthetic user)', async () => {
    mockFetchUser.mockResolvedValueOnce({
      id: 1,
      login: 'localuser',
      name: null,
      avatar_url: null,
      email: null,
    });
    const app = makeApp(buildDeps(), {
      authLocalOrgBypass: true,
      authOrgId: 'default',
    });
    const res = await request(app)
      .post('/api/auth/github/connect-token')
      .send({ token: 'ghp_local' });
    expect(res.status).toBe(200);
    expect(res.body.login).toBe('localuser');
  });

  it('works even when server-side OAuth creds are not configured (key benefit of PAT path)', async () => {
    const user = createUser({ username: 'alice', passwordHash: 'x' });
    mockFetchUser.mockResolvedValueOnce({
      id: 1,
      login: 'pat-user',
      name: null,
      avatar_url: null,
      email: null,
    });
    // No githubApp configured — OAuth flow would 503 here, but PAT flow works.
    const app = makeApp(buildDeps({ config: { githubApp: null } }), {
      authUserId: user.id,
    });
    const res = await request(app)
      .post('/api/auth/github/connect-token')
      .send({ token: 'ghp_xxx' });
    expect(res.status).toBe(200);
    expect(getGithubConnection(user.id)?.login).toBe('pat-user');
  });
});
