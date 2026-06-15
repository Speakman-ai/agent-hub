/**
 * Integration tests for the per-user Cursor / Gemini / Codex credentials
 * endpoints. Companion to `auth-claude-auth.test.ts` — the Claude path
 * carries an OAuth token + expiry, while these three engines each carry
 * a single API key, so they share one parameterised suite here.
 *
 * Covers per engine:
 *   - 401 when authUserId is missing (apiKey-only callers)
 *   - 404 when the resolved authUserId points at no user row
 *   - PUT body whitelist (stray keys must not reach the DB)
 *   - GET masks the key and returns hostConfigFallback
 *   - PUT round-trips a key, returns the mask, includes hostConfigFallback
 *   - empty-string clears the stored value
 *   - per-engine isolation — writing one engine's key does not bleed into others
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync, writeFileSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: {
  apiKey: string | null;
  anthropicApiKey: string | null;
  claudeCodeOAuthToken: string | null;
  cursorApiKey: string | null;
  geminiApiKey: string | null;
  codexApiKey: string | null;
  xaiApiKey: string | null;
  codexBin: string;
  dataDir: string;
} = {
  apiKey: null,
  anthropicApiKey: null,
  claudeCodeOAuthToken: null,
  cursorApiKey: null,
  geminiApiKey: null,
  codexApiKey: null,
  xaiApiKey: null,
  codexBin: '',
  get dataDir() {
    return TMP_DIR;
  },
} as typeof mockConfig;

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg } = await import('../orgs.js');
const {
  getUserByUsername,
  getUserCursorAuth,
  getUserGeminiAuth,
  getUserCodexAuth,
  getUserGrokAuth,
} = await import('../users-store.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

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
    .send({ username: 'owner', password: 'a-strong-password' });
  if (res.status !== 200)
    throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-engine-auth-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // Force the multi-user auth path — local-bundled-server bypass would
  // mint a synthetic Owner without authUserId and break the 401 cases.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
  mockConfig.anthropicApiKey = null;
  mockConfig.claudeCodeOAuthToken = null;
  mockConfig.cursorApiKey = null;
  mockConfig.geminiApiKey = null;
  mockConfig.codexApiKey = null;
  mockConfig.xaiApiKey = null;
  // Default to a binary path that does NOT exist on disk. Individual
  // tests that need the binary "installed" can stamp a fixture into
  // `TMP_DIR` and point `codexBin` at it.
  mockConfig.codexBin = path.join(TMP_DIR, 'codex-not-installed');
});

type EngineFixture = {
  engine: 'cursor' | 'gemini' | 'codex' | 'grok';
  path: string;
  /** Mutates `mockConfig.<engineHostKey>`. */
  setHost: (v: string | null) => void;
  /** Reads the stored value from the DB. */
  read: (userId: string) => { apiKey: string | null } | null;
  sampleKey: string;
  /**
   * Whether this engine still has a host-config fallback. Only Gemini is
   * host-configured now; Cursor / Codex are strictly per-account, so their
   * `hostConfigFallback.apiKey` is always false even when a host env value
   * is present.
   */
  hasHostFallback: boolean;
};

const engineFixtures: EngineFixture[] = [
  {
    engine: 'cursor',
    path: '/api/auth/me/cursor-auth',
    setHost: (v) => {
      mockConfig.cursorApiKey = v;
    },
    read: (userId) => getUserCursorAuth(userId),
    sampleKey: 'curs-AAAA-BBBB',
    hasHostFallback: false,
  },
  {
    engine: 'gemini',
    path: '/api/auth/me/gemini-auth',
    setHost: (v) => {
      mockConfig.geminiApiKey = v;
    },
    read: (userId) => getUserGeminiAuth(userId),
    sampleKey: 'gem-XXXX-YYYY',
    hasHostFallback: true,
  },
  {
    engine: 'codex',
    path: '/api/auth/me/codex-auth',
    setHost: (v) => {
      mockConfig.codexApiKey = v;
    },
    read: (userId) => getUserCodexAuth(userId),
    sampleKey: 'sk-codex-RoundTrip',
    hasHostFallback: false,
  },
  {
    engine: 'grok',
    path: '/api/auth/me/grok-auth',
    // Grok (xAI) is host-configured like Gemini: the host xaiApiKey is a
    // valid fallback, so `hostConfigFallback.apiKey` must reflect it.
    setHost: (v) => {
      mockConfig.xaiApiKey = v;
    },
    read: (userId) => getUserGrokAuth(userId),
    sampleKey: 'xai-RoundTrip-1234',
    hasHostFallback: true,
  },
];

for (const fx of engineFixtures) {
  describe(`GET ${fx.path}`, () => {
    it('returns 401 when the caller has no authUserId (apiKey break-glass)', async () => {
      const app = buildGatedApp();
      await setupOwner(app);
      mockConfig.apiKey = 'test-shared-secret';

      const res = await supertest(app).get(fx.path).set('x-api-key', 'test-shared-secret');
      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authentication/i);
    });

    it('returns 404 when the resolved authUserId points at no user row', async () => {
      const gatedApp = buildGatedApp();
      await setupOwner(gatedApp);

      const stubApp = buildStubbedApp({
        authUserId: 'ghost-user-id-does-not-exist',
        authUser: 'ghost',
      });
      const res = await supertest(stubApp).get(fx.path);
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found/i);
    });

    it('returns masked apiKey and hostConfigFallback per the engine host-fallback policy', async () => {
      const app = buildGatedApp();
      const ownerToken = await setupOwner(app);

      // Stamp the user with a sample key first.
      await supertest(app)
        .put(fx.path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: fx.sampleKey });

      // Point host config at a fallback value. Only Gemini honors it; Cursor
      // and Codex are per-account-only and must keep the flag false.
      fx.setHost('host-fallback-value');

      const res = await supertest(app).get(fx.path).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe(fx.engine);
      expect(typeof res.body.apiKey).toBe('string');
      expect(res.body.apiKey.endsWith('…')).toBe(true);
      // Never echo the raw value.
      expect(res.body.apiKey).not.toBe(fx.sampleKey);
      expect(res.body.hostConfigFallback).toEqual({ apiKey: fx.hasHostFallback });
    });

    it('reports hostConfigFallback false when host has no key configured', async () => {
      const app = buildGatedApp();
      const ownerToken = await setupOwner(app);
      const res = await supertest(app).get(fx.path).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body.hostConfigFallback).toEqual({ apiKey: false });
      expect(res.body.apiKey).toBeNull();
    });
  });

  describe(`PUT ${fx.path}`, () => {
    it('returns 401 when the caller has no authUserId', async () => {
      const app = buildGatedApp();
      await setupOwner(app);
      mockConfig.apiKey = 'test-shared-secret';

      const res = await supertest(app)
        .put(fx.path)
        .set('x-api-key', 'test-shared-secret')
        .send({ apiKey: fx.sampleKey });
      expect(res.status).toBe(401);
    });

    it('returns 404 when the resolved authUserId points at no user row', async () => {
      const gatedApp = buildGatedApp();
      await setupOwner(gatedApp);

      const stubApp = buildStubbedApp({
        authUserId: 'ghost-user-id-does-not-exist',
        authUser: 'ghost',
      });
      const res = await supertest(stubApp).put(fx.path).send({ apiKey: fx.sampleKey });
      expect(res.status).toBe(404);
    });

    it('whitelists fields — stray JSON keys must not reach the DB', async () => {
      const app = buildGatedApp();
      const ownerToken = await setupOwner(app);
      const owner = getUserByUsername('owner')!;

      const res = await supertest(app)
        .put(fx.path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          apiKey: fx.sampleKey,
          passwordHash: 'INJECTED',
          username: 'attacker',
          anthropicApiKey: 'sk-ant-api03-LEAK',
        });
      expect(res.status).toBe(200);

      const stored = fx.read(owner.id);
      expect(stored?.apiKey).toBe(fx.sampleKey);

      const reloaded = getUserByUsername('owner');
      expect(reloaded?.username).toBe('owner');
      expect(reloaded?.password_hash).not.toBe('INJECTED');
    });

    it('returns the masked key on response and includes hostConfigFallback', async () => {
      const app = buildGatedApp();
      const ownerToken = await setupOwner(app);
      // No host fallback so we assert the false branch.
      fx.setHost(null);

      const res = await supertest(app)
        .put(fx.path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: fx.sampleKey });
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe(fx.engine);
      expect(res.body.apiKey.endsWith('…')).toBe(true);
      expect(res.body.apiKey).not.toBe(fx.sampleKey);
      expect(res.body.updatedAt).toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(res.body.hostConfigFallback).toEqual({ apiKey: false });
    });

    it('clears the stored field when passed an empty string', async () => {
      const app = buildGatedApp();
      const ownerToken = await setupOwner(app);
      const owner = getUserByUsername('owner')!;

      await supertest(app)
        .put(fx.path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: fx.sampleKey });
      expect(fx.read(owner.id)?.apiKey).toBe(fx.sampleKey);

      const clear = await supertest(app)
        .put(fx.path)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ apiKey: '' });
      expect(clear.status).toBe(200);
      expect(clear.body.apiKey).toBeNull();
      expect(fx.read(owner.id)?.apiKey).toBeNull();
    });
  });
}

// Regression: `GET /api/auth/me/codex-auth` enriches the response with a
// `deviceLogin.uiStatus` derived from `computeCodexUiStatus`. The
// `binaryPresent` gate MUST reflect the actual `codexBin` on disk —
// otherwise an operator who stored an API key but never installed the
// CLI would see `uiStatus: 'authenticated'` and any downstream Codex
// spawn would fail with "Codex binary not found". This was flagged on
// PR #1022.
describe('GET /api/auth/me/codex-auth — deviceLogin.uiStatus binary gate', () => {
  it("returns uiStatus 'missing' when the codex binary is absent, even with an API key set", async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Store a per-user API key so the apiKey branch of
    // computeCodexUiStatus would otherwise return 'authenticated'.
    await supertest(app)
      .put('/api/auth/me/codex-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 'sk-codex-Test' });

    // `mockConfig.codexBin` defaults to a path that does not exist.
    const res = await supertest(app)
      .get('/api/auth/me/codex-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deviceLogin).toBeTruthy();
    expect(res.body.deviceLogin.uiStatus).toBe('missing');
  });

  it("returns uiStatus 'authenticated' when the codex binary exists and an API key is set", async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Stamp a fake binary into TMP_DIR and point codexBin at it.
    const fakeBin = path.join(TMP_DIR, 'codex-installed');
    writeFileSync(fakeBin, '');
    mockConfig.codexBin = fakeBin;

    await supertest(app)
      .put('/api/auth/me/codex-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 'sk-codex-Test' });

    const res = await supertest(app)
      .get('/api/auth/me/codex-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body.deviceLogin.uiStatus).toBe('authenticated');
  });
});

// One cross-engine isolation check to verify that the route handlers
// each touch the right column — i.e. that the per-route store wiring
// hasn't been transposed at the route layer (writing Cursor's key into
// Gemini's column, etc.).
describe('per-user engine routes — write isolation across engines', () => {
  it('writing one engine never bleeds into the others', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const owner = getUserByUsername('owner')!;

    await supertest(app)
      .put('/api/auth/me/cursor-auth')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ apiKey: 'curs-only-key' });

    // The other two single-key engines must stay null on the DB row.
    expect(getUserCursorAuth(owner.id)?.apiKey).toBe('curs-only-key');
    expect(getUserGeminiAuth(owner.id)?.apiKey).toBeNull();
    expect(getUserCodexAuth(owner.id)?.apiKey).toBeNull();

    // GET responses for the other engines must also reflect "not configured".
    const geminiGet = await supertest(app)
      .get('/api/auth/me/gemini-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(geminiGet.status).toBe(200);
    expect(geminiGet.body.apiKey).toBeNull();

    const codexGet = await supertest(app)
      .get('/api/auth/me/codex-auth')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(codexGet.status).toBe(200);
    expect(codexGet.body.apiKey).toBeNull();
  });
});
