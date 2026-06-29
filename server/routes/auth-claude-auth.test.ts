/**
 * Integration tests for the per-user Claude credentials endpoints.
 *
 * Covers:
 *   - 401 when authUserId is missing (apiKey-only callers — no per-user identity)
 *   - 404 when authenticated as a user that no longer exists in the users table
 *   - PUT body whitelist (stray keys must not reach the DB)
 *   - GET masks credentials and returns hostConfigFallback flags
 *   - PUT round-trips a stored credential, masked on response
 *
 * Mirrors the test scaffolding in `auth-phase3.test.ts`: a real Express
 * app + real orgs.db in a tmpdir so the auth middleware, stores, and
 * routes all exercise production wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: {
  apiKey: string | null;
  anthropicApiKey: string | null;
  claudeCodeOAuthToken: string | null;
  dataDir: string;
} = {
  apiKey: null,
  anthropicApiKey: null,
  claudeCodeOAuthToken: null,
  get dataDir() {
    return TMP_DIR;
  },
} as typeof mockConfig;

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg } = await import('../orgs.js');
const { getUserByUsername, getUserClaudeAuth } = await import('../users-store.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

/**
 * Build an app with a stub middleware that injects `authUserId` /
 * `authUser` directly. Used for testing the route's own 401/404
 * branches without going through `authMiddleware`, which short-circuits
 * to 401 before the route runs when the user row is missing.
 */
function buildStubbedApp(stub: { authUserId?: string; authUser?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (stub.authUserId !== undefined) {
      (req as unknown as { authUserId?: string }).authUserId = stub.authUserId;
    }
    if (stub.authUser !== undefined) {
      (req as unknown as { authUser?: string }).authUser = stub.authUser;
    }
    next();
  });
  app.use(createAuthRoutes());
  return app;
}

async function setupOwner(app: ReturnType<typeof buildGatedApp>) {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'a-strong-password' });
  if (res.status !== 200)
    throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-claude-auth-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // Force the multi-user auth path; otherwise the local-bundled-server
  // bypass would mint a synthetic Owner without an `authUserId` and
  // change the 401-vs-200 outcome we're trying to assert.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
  mockConfig.anthropicApiKey = null;
  mockConfig.claudeCodeOAuthToken = null;
});

describe('GET /api/auth/me/claude-auth', () => {
  it('returns 401 when the caller has no authUserId (apiKey break-glass)', async () => {
    const app = buildGatedApp();
    await setupOwner(app);

    // Promote the legacy shared-secret apiKey. apiKey callers are
    // treated as Owner but never carry a `uid` claim, so authUserId is
    // unset — exactly the path the route is meant to refuse.
    mockConfig.apiKey = 'test-shared-secret';

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('x-api-key', 'test-shared-secret');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication/i);
  });

  it('returns 404 when the resolved authUserId points at no user row', async () => {
    // The auth middleware itself rejects deleted users with 401 before
    // reaching the route, so to exercise the route's defensive 404
    // branch (which guards against a race between auth resolution and
    // the DB lookup) we bypass the middleware and inject an
    // authUserId that has no corresponding users row.
    const gatedApp = buildGatedApp();
    await setupOwner(gatedApp);

    const stubApp = buildStubbedApp({
      authUserId: 'ghost-user-id-does-not-exist',
      authUser: 'ghost',
    });
    const res = await supertest(stubApp).get('/api/auth/me/claude-auth');
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns masked credentials and hostConfigFallback always false (no host fallback)', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Stamp the user with a real-shaped Anthropic key so we can assert
    // the mask shape on response.
    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ anthropicApiKey: 'sk-ant-api03-AAAA-BBBB-CCCC' });

    // Even if a host process env carried a key, Claude auth is strictly
    // per-account now: hostConfigFallback must stay false.
    mockConfig.anthropicApiKey = 'sk-ant-api03-host-fallback';
    mockConfig.claudeCodeOAuthToken = null;

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.anthropicApiKey).toMatch(/^sk-ant-api03-…$/);
    expect(res.body.claudeCodeOAuthToken).toBeNull();
    expect(res.body.hostConfigFallback).toEqual({
      anthropicApiKey: false,
      claudeCodeOAuthToken: false,
    });
  });
});

describe('PUT /api/auth/me/claude-auth', () => {
  it('returns 401 when the caller has no authUserId', async () => {
    const app = buildGatedApp();
    await setupOwner(app);
    mockConfig.apiKey = 'test-shared-secret';

    const res = await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('x-api-key', 'test-shared-secret')
      .send({ anthropicApiKey: 'sk-ant-api03-XXXX' });
    expect(res.status).toBe(401);
  });

  it('returns 404 when the resolved authUserId points at no user row', async () => {
    // Same approach as the GET 404 case — bypass the middleware and
    // inject an authUserId with no matching users row to reach the
    // route's defensive 404 branch.
    const gatedApp = buildGatedApp();
    await setupOwner(gatedApp);

    const stubApp = buildStubbedApp({
      authUserId: 'ghost-user-id-does-not-exist',
      authUser: 'ghost',
    });
    const res = await supertest(stubApp)
      .put('/api/auth/me/claude-auth')
      .send({ anthropicApiKey: 'sk-ant-api03-XXXX' });
    expect(res.status).toBe(404);
  });

  it('whitelists fields — stray JSON keys must not reach the DB', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const owner = getUserByUsername('owner@example.com')!;

    // Try to smuggle a non-whitelisted key plus a whitelisted one. Only
    // the whitelisted field should round-trip; the smuggled key must
    // not show up anywhere in the stored row.
    const res = await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        anthropicApiKey: 'sk-ant-api03-WHITELISTED',
        passwordHash: 'INJECTED', // stray key — must be ignored
        username: 'attacker', // stray key — must be ignored
      });
    expect(res.status).toBe(200);

    const stored = getUserClaudeAuth(owner.id);
    expect(stored?.anthropicApiKey).toBe('sk-ant-api03-WHITELISTED');

    // Verify the stray keys did not corrupt the user row itself.
    const reloaded = getUserByUsername('owner@example.com');
    expect(reloaded?.username).toBe('owner@example.com');
    expect(reloaded?.password_hash).not.toBe('INJECTED');
  });

  it('returns the masked credential on response and includes hostConfigFallback (always false)', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    mockConfig.anthropicApiKey = null;
    mockConfig.claudeCodeOAuthToken = 'host-oauth-fallback-token';

    const res = await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ anthropicApiKey: 'sk-ant-api03-RoundTrip-1234' });
    expect(res.status).toBe(200);
    expect(res.body.anthropicApiKey).toMatch(/^sk-ant-api03-…$/);
    expect(res.body.claudeCodeOAuthToken).toBeNull();
    expect(res.body.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Claude auth is strictly per-account — no host fallback, so both
    // flags stay false regardless of any host process env.
    expect(res.body.hostConfigFallback).toEqual({
      anthropicApiKey: false,
      claudeCodeOAuthToken: false,
    });
  });

  it('clears a stored field when passed an empty string', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const owner = getUserByUsername('owner@example.com')!;

    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ anthropicApiKey: 'sk-ant-api03-WILL-BE-CLEARED' });
    expect(getUserClaudeAuth(owner.id)?.anthropicApiKey).toBe('sk-ant-api03-WILL-BE-CLEARED');

    const clear = await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ anthropicApiKey: '' });
    expect(clear.status).toBe(200);
    expect(clear.body.anthropicApiKey).toBeNull();
    expect(getUserClaudeAuth(owner.id)?.anthropicApiKey).toBeNull();
  });
});

// ── Expiry normalisation parity with the host-config path ─────────────
//
// Regression for the user-visible bug "Auth UI keeps showing token
// expired when it is not". Before this fix, the per-user route echoed
// `claudeCodeOAuthExpiresAt` verbatim — so a value stored in JWT-style
// Unix seconds (~1.7e9) would compare against `Date.now()` (~1.7e12) on
// the client and render as "Expired" for ~55 years. The host-config
// path was already running its expiry through
// `normalizeOAuthExpiresAtMs` (PR #723); the per-user path now does the
// same and additionally returns a server-computed `expired` boolean so
// the UI doesn't have to recompute the comparison.
describe('GET /api/auth/me/claude-auth — expiry normalisation', () => {
  it('reports expired:false for a future expiry stored as Unix seconds', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const futureSec = Math.floor(Date.now() / 1000) + 3600;

    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ claudeCodeOAuthExpiresAt: String(futureSec) });

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBe(false);
    // Server should have promoted the stored seconds into a normalised
    // ISO string before responding so the client doesn't re-derive the
    // unit from an ambiguous numeric string.
    expect(typeof res.body.claudeCodeOAuthExpiresAt).toBe('string');
    expect(Date.parse(res.body.claudeCodeOAuthExpiresAt)).toBe(futureSec * 1000);
  });

  it('reports expired:false for a future expiry stored as epoch ms', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const futureMs = Date.now() + 86_400_000; // +24h

    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ claudeCodeOAuthExpiresAt: String(futureMs) });

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBe(false);
    expect(Date.parse(res.body.claudeCodeOAuthExpiresAt)).toBe(futureMs);
  });

  it('reports expired:false for a future expiry stored as ISO 8601', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const futureMs = Date.now() + 3_600_000;
    const iso = new Date(futureMs).toISOString();

    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ claudeCodeOAuthExpiresAt: iso });

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBe(false);
    expect(res.body.claudeCodeOAuthExpiresAt).toBe(iso);
  });

  it('reports expired:true for a past expiry stored as Unix seconds', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const pastSec = Math.floor(Date.now() / 1000) - 3600;

    await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ claudeCodeOAuthExpiresAt: String(pastSec) });

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBe(true);
  });

  it('returns null expired flag when no expiry is stored', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .get('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBeNull();
    expect(res.body.claudeCodeOAuthExpiresAt).toBeNull();
  });

  it('PUT response mirrors the GET shape — clients can render without a follow-up fetch', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const futureSec = Math.floor(Date.now() / 1000) + 7200;

    const res = await supertest(app)
      .put('/api/auth/me/claude-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ claudeCodeOAuthExpiresAt: String(futureSec) });
    expect(res.status).toBe(200);
    expect(res.body.claudeCodeOAuthExpired).toBe(false);
    expect(typeof res.body.claudeCodeOAuthExpiresAt).toBe('string');
    expect(Date.parse(res.body.claudeCodeOAuthExpiresAt)).toBe(futureSec * 1000);
  });
});
