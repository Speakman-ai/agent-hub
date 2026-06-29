import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import path from 'path';

// Point the auth store at a throwaway tmp dir per test. We rewire the
// config module used by auth-store via vi.mock so the file lives
// somewhere we own and can clean up.
let TMP_DIR = '';
const mockConfig: { apiKey: string | null; dataDir: string } = {
  apiKey: null,
  get dataDir() {
    return TMP_DIR;
  },
} as { apiKey: string | null; dataDir: string };

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { reloadAuthRecord, setAuthFilePathForTests, getAuthRecord, saveAuthRecord } =
  await import('../auth-store.js');
const { hashPassword } = await import('../password.js');
const { createMembership } = await import('../memberships-store.js');
const { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser, getUserByUsername } = await import('../users-store.js');

function buildApp(): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  app.use(createAuthRoutes());
  return app;
}

/**
 * Build an app that runs the real `authMiddleware` before the routes —
 * used by the regression tests that verify the middleware-level apiKey
 * gate on /api/auth/setup.
 */
function buildGatedApp(): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

function buildLocalBypassApp(): ReturnType<typeof express> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      authRole: 'Owner',
      authLocalOrgBypass: true,
    });
    next();
  });
  app.use(createAuthRoutes());
  return app;
}

describe('POST /api/auth/setup', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  });

  it('creates the single-user record and returns a token', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user).toEqual({
      email: 'owner@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(true);
    expect(getAuthRecord()?.username).toBe('owner@example.com');
  });

  it('rejects a short password', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('rejects an invalid email', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'has spaces!', password: 'a-strong-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  it('refuses to re-run setup once auth is configured', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/auth/setup — apiKey-gated deployments (PR #407 regression)', () => {
  // These tests go through the real `authMiddleware` to verify the
  // first-run setup window cannot be hijacked by unauthenticated clients
  // on deployments that are already protected only by `config.apiKey`.
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    mockConfig.apiKey = null;
  });

  it('rejects setup without X-API-Key when apiKey is configured', async () => {
    mockConfig.apiKey = 'legacy-key';
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .send({ email: 'impostor@example.com', password: 'picked-by-attacker' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/API key required/i);
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(false);
    expect(getAuthRecord()).toBeNull();
  });

  it('rejects setup with wrong X-API-Key when apiKey is configured', async () => {
    mockConfig.apiKey = 'legacy-key';
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .set('X-API-Key', 'wrong-key')
      .send({ email: 'impostor@example.com', password: 'picked-by-attacker' });
    // 403 when a key was provided but didn't match (existing apiKey path);
    // 401 when no key was provided. Either way the handler must not run
    // and auth.json must not be written.
    expect([401, 403]).toContain(res.status);
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(false);
  });

  it('accepts setup with the matching X-API-Key', async () => {
    mockConfig.apiKey = 'legacy-key';
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .set('X-API-Key', 'legacy-key')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(true);
  });

  it('still allows setup on deployments with no apiKey configured', async () => {
    mockConfig.apiKey = null;
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    // Seed a user.
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'correct-password' });
    reloadAuthRecord();
  });

  it('returns a JWT for correct credentials', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user.email).toBe('owner@example.com');
    expect(res.body.user.needsEmailUpdate).toBe(false);
  });

  it('rejects wrong password with 401', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects unknown email with 401', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'impostor@example.com', password: 'correct-password' });
    expect(res.status).toBe(401);
  });

  it('still accepts a legacy non-email username and flags the email update prompt', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-legacy-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: await hashPassword('correct-password'),
      jwtSecret: 'legacy-secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'legacy-owner', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({
      email: null,
      needsEmailUpdate: true,
      role: 'Owner',
    });
    expect(res.body.user.username).toBeUndefined();
  });

  it('returns a compatibility error for malformed login identifiers', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'has spaces!', password: 'correct-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid email or username');
  });

  it('lets an auth.json-only legacy owner complete the email update prompt', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-legacy-email-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: await hashPassword('correct-password'),
      jwtSecret: 'legacy-secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const loginRes = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'legacy-owner', password: 'correct-password' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.needsEmailUpdate).toBe(true);

    const updateRes = await supertest(buildGatedApp())
      .put('/api/auth/me/email')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ email: 'legacy-owner@example.com' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.user).toMatchObject({
      email: 'legacy-owner@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
    expect(updateRes.body.user.username).toBeUndefined();
    expect(getAuthRecord()?.username).toBe('legacy-owner@example.com');
  });

  it('lets local bundled auth bypass complete the auth.json email update prompt', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-local-email-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: await hashPassword('correct-password'),
      jwtSecret: 'legacy-secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const updateRes = await supertest(buildLocalBypassApp())
      .put('/api/auth/me/email')
      .send({ email: 'local-owner@example.com' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.user).toMatchObject({
      email: 'local-owner@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
    expect(updateRes.body.user.username).toBeUndefined();
    expect(getAuthRecord()?.username).toBe('local-owner@example.com');
  });

  it('keeps the matching user row in sync when local bundled auth bypass updates email', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-local-email-db-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    try {
      const passwordHash = await hashPassword('correct-password');
      saveAuthRecord({
        username: 'legacy-local-owner',
        passwordHash,
        jwtSecret: 'legacy-secret',
        role: 'Owner',
      });
      reloadAuthRecord();
      const legacy = createUser({ username: 'legacy-local-owner', passwordHash });
      createMembership(legacy.id, 'default', 'Owner');

      const updateRes = await supertest(buildLocalBypassApp())
        .put('/api/auth/me/email')
        .send({ email: 'local-owner-db@example.com' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.user).toMatchObject({
        id: legacy.id,
        email: 'local-owner-db@example.com',
        needsEmailUpdate: false,
        role: 'Owner',
      });
      expect(updateRes.body.user.username).toBeUndefined();
      expect(getAuthRecord()?.username).toBe('local-owner-db@example.com');
      expect(getUserByUsername('legacy-local-owner')).toBeNull();
      expect(getUserByUsername('local-owner-db@example.com')?.id).toBe(legacy.id);
    } finally {
      setOrgsDbPathForTests(null);
    }
  });

  it('preserves the user id when local bundled auth bypass repeats an email update', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-local-email-repeat-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    try {
      const passwordHash = await hashPassword('correct-password');
      saveAuthRecord({
        username: 'local-owner-repeat@example.com',
        passwordHash,
        jwtSecret: 'legacy-secret',
        role: 'Owner',
      });
      reloadAuthRecord();
      const existing = createUser({ username: 'local-owner-repeat@example.com', passwordHash });
      createMembership(existing.id, 'default', 'Owner');

      const updateRes = await supertest(buildLocalBypassApp())
        .put('/api/auth/me/email')
        .send({ email: 'local-owner-repeat@example.com' });

      expect(updateRes.status).toBe(200);
      expect(updateRes.body.user).toMatchObject({
        id: existing.id,
        email: 'local-owner-repeat@example.com',
        needsEmailUpdate: false,
        role: 'Owner',
      });
    } finally {
      setOrgsDbPathForTests(null);
    }
  });

  it('does not rewrite auth.json when local bundled auth bypass hits a users DB failure', async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-local-email-db-fail-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    try {
      const passwordHash = await hashPassword('correct-password');
      saveAuthRecord({
        username: 'legacy-local-owner-db-fail',
        passwordHash,
        jwtSecret: 'legacy-secret',
        role: 'Owner',
      });
      reloadAuthRecord();
      createUser({ username: 'legacy-local-owner-db-fail', passwordHash });
      getOrgsDb().exec('DROP TABLE users');

      const updateRes = await supertest(buildLocalBypassApp())
        .put('/api/auth/me/email')
        .send({ email: 'local-owner-db-fail@example.com' });

      expect(updateRes.status).toBe(500);
      expect(updateRes.body.error).toMatch(/users store/i);
      expect(getAuthRecord()?.username).toBe('legacy-local-owner-db-fail');
    } finally {
      setOrgsDbPathForTests(null);
    }
  });

  it('409s when auth has not been set up yet', async () => {
    // Fresh dir — no user.
    rmSync(TMP_DIR, { recursive: true });
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'correct-password' });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/status', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    mockConfig.apiKey = null;
  });

  it('reports unconfigured before setup', async () => {
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.status).toBe(200);
    // `activeOrgIsLocal` is `false` here because AGENT_HUB_MODE is
    // unset in the test environment — defaulting to multi-user mode.
    expect(res.body).toEqual({
      authConfigured: false,
      email: null,
      needsEmailUpdate: false,
      role: null,
      jwtConfigured: false,
      apiKeyConfigured: false,
      needsMigration: false,
      activeOrgIsLocal: false,
    });
  });

  it('reports configured without exposing the account email after setup', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    reloadAuthRecord();
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.body).toEqual({
      authConfigured: true,
      email: null,
      needsEmailUpdate: false,
      role: 'Owner',
      jwtConfigured: true,
      apiKeyConfigured: false,
      needsMigration: false,
      activeOrgIsLocal: false,
    });
  });

  it('reports legacy email-update need without exposing the legacy identifier', async () => {
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash: await hashPassword('a-strong-password'),
      jwtSecret: 'legacy-secret',
      role: 'Owner',
    });
    reloadAuthRecord();

    const res = await supertest(buildApp()).get('/api/auth/status');

    expect(res.body).toMatchObject({
      authConfigured: true,
      email: null,
      needsEmailUpdate: true,
      role: 'Owner',
    });
    expect(res.body.username).toBeUndefined();
  });
});

// Dedicated block for `activeOrgIsLocal` — exercises the env-driven
// signal that replaces the previous `org.mode='local'` lookup. The
// status endpoint is the public surface AuthGate consumes to decide
// whether to render the login screen, so the field must follow
// AGENT_HUB_MODE exactly: `'local'` → true, anything else → false.
describe('GET /api/auth/status — activeOrgIsLocal field', () => {
  const originalMode = process.env.AGENT_HUB_MODE;
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    delete process.env.AGENT_HUB_MODE;
  });

  afterEach(() => {
    if (originalMode === undefined) delete process.env.AGENT_HUB_MODE;
    else process.env.AGENT_HUB_MODE = originalMode;
  });

  it('reports true when AGENT_HUB_MODE=local (Electron / dev)', async () => {
    process.env.AGENT_HUB_MODE = 'local';
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.activeOrgIsLocal).toBe(true);
  });

  it('reports false when AGENT_HUB_MODE is unset (default web deploy)', async () => {
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body.activeOrgIsLocal).toBe(false);
  });

  it('reports false for non-local AGENT_HUB_MODE values', async () => {
    for (const v of ['', 'remote', 'LOCAL', 'true', ' local ']) {
      process.env.AGENT_HUB_MODE = v;
      const res = await supertest(buildApp()).get('/api/auth/status');
      expect(res.body.activeOrgIsLocal).toBe(false);
    }
  });
});

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
  });

  it('returns ok (stateless — client drops the token)', async () => {
    const res = await supertest(buildApp()).post('/api/auth/logout');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});

// ── Role-based permissions (Phase 2) ────────────────────────────
describe('Phase 2 — role assignment', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    mockConfig.apiKey = null;
  });

  it('setup assigns Owner and returns it in the user payload', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      email: 'owner@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
    reloadAuthRecord();
    expect(getAuthRecord()?.role).toBe('Owner');
  });

  it('login returns the stored role', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    reloadAuthRecord();
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({
      email: 'owner@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
  });

  it('status exposes the owner role publicly', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    reloadAuthRecord();
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.body.role).toBe('Owner');
  });
});

describe('GET /api/auth/users (requireRole Admin)', () => {
  beforeEach(async () => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    mockConfig.apiKey = null;
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    reloadAuthRecord();
  });

  it('returns the user roster to a JWT-authenticated Owner', async () => {
    const login = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const token: string = login.body.token;

    const res = await supertest(buildGatedApp())
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ email: 'owner@example.com', role: 'Owner' });
  });

  it('rejects unauthenticated requests', async () => {
    const res = await supertest(buildGatedApp()).get('/api/auth/users');
    expect(res.status).toBe(401);
  });

  it('treats the apiKey fallback as Owner (full privilege)', async () => {
    mockConfig.apiKey = 'shared-secret';
    const res = await supertest(buildGatedApp())
      .get('/api/auth/users')
      .set('X-API-Key', 'shared-secret');
    expect(res.status).toBe(200);
    expect(res.body.users[0]?.role).toBe('Owner');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Zod body validation — surfaces 400 with structured Zod issues
// ─────────────────────────────────────────────────────────────────────
//
// These guard the OpenAPI-migration contract: every route that used to
// extract fields off `req.body` ad-hoc now runs the body through a Zod
// schema and returns a 400 with either a legacy-compatible error string
// (for fields whose wording downstream clients still match on) OR a
// structured `{ error, issues: [...] }` envelope for unrecognised shape
// problems. Legacy-message tests already live elsewhere in this file —
// this block is the "garbage body" / Zod-shape regression.
describe('Zod body validation — 400 on malformed bodies', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    mockConfig.apiKey = null;
    reloadAuthRecord();
  });
  afterEach(() => {
    setAuthFilePathForTests(null);
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('POST /api/auth/setup returns Zod 400 when both fields are wrong types', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 123, password: { not: 'a string' } });
    expect(res.status).toBe(400);
    // Credential bodies are a one-of schema (`email` or legacy `username`),
    // so malformed identifiers can surface as a union-level issue. The contract
    // this test pins is the structured Zod envelope, not a fixed issue count.
    expect(res.body).toHaveProperty('issues');
    expect(Array.isArray(res.body.issues)).toBe(true);
    expect(res.body.issues.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/auth/login returns Zod 400 when body is null', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('null');
    expect(res.status).toBe(400);
  });
});
