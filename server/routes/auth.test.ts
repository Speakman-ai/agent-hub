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
const { reloadAuthRecord, setAuthFilePathForTests, getAuthRecord } =
  await import('../auth-store.js');

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

describe('POST /api/auth/setup', () => {
  beforeEach(() => {
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  });

  it('creates the single-user record and returns a token', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user).toEqual({ username: 'owner', role: 'Owner' });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(true);
    expect(getAuthRecord()?.username).toBe('owner');
  });

  it('rejects a short password', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/password/i);
  });

  it('rejects an invalid username', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'has spaces!', password: 'a-strong-password' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/username/i);
  });

  it('refuses to re-run setup once auth is configured', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
    const res = await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
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
      .send({ username: 'impostor', password: 'picked-by-attacker' });
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
      .send({ username: 'impostor', password: 'picked-by-attacker' });
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
      .send({ username: 'owner', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(existsSync(path.join(TMP_DIR, 'auth.json'))).toBe(true);
  });

  it('still allows setup on deployments with no apiKey configured', async () => {
    mockConfig.apiKey = null;
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
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
      .send({ username: 'owner', password: 'correct-password' });
    reloadAuthRecord();
  });

  it('returns a JWT for correct credentials', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'correct-password' });
    expect(res.status).toBe(200);
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user.username).toBe('owner');
  });

  it('rejects wrong password with 401', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'wrong-password' });
    expect(res.status).toBe(401);
  });

  it('rejects unknown username with 401', async () => {
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'impostor', password: 'correct-password' });
    expect(res.status).toBe(401);
  });

  it('409s when auth has not been set up yet', async () => {
    // Fresh dir — no user.
    rmSync(TMP_DIR, { recursive: true });
    TMP_DIR = mkdtempSync(path.join(tmpdir(), 'agent-hub-auth-test-'));
    setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
    reloadAuthRecord();
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'correct-password' });
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
      username: null,
      role: null,
      jwtConfigured: false,
      apiKeyConfigured: false,
      needsMigration: false,
      activeOrgIsLocal: false,
    });
  });

  it('reports configured + username after setup', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
    reloadAuthRecord();
    const res = await supertest(buildApp()).get('/api/auth/status');
    expect(res.body).toEqual({
      authConfigured: true,
      username: 'owner',
      role: 'Owner',
      jwtConfigured: true,
      apiKeyConfigured: false,
      needsMigration: false,
      activeOrgIsLocal: false,
    });
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
      .send({ username: 'owner', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ username: 'owner', role: 'Owner' });
    reloadAuthRecord();
    expect(getAuthRecord()?.role).toBe('Owner');
  });

  it('login returns the stored role', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
    reloadAuthRecord();
    const res = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'a-strong-password' });
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ username: 'owner', role: 'Owner' });
  });

  it('status exposes the owner role publicly', async () => {
    await supertest(buildApp())
      .post('/api/auth/setup')
      .send({ username: 'owner', password: 'a-strong-password' });
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
      .send({ username: 'owner', password: 'a-strong-password' });
    reloadAuthRecord();
  });

  it('returns the user roster to a JWT-authenticated Owner', async () => {
    const login = await supertest(buildApp())
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'a-strong-password' });
    const token: string = login.body.token;

    const res = await supertest(buildGatedApp())
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ username: 'owner', role: 'Owner' });
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
