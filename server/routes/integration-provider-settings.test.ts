/**
 * Integration tests for the `/api/admin/integrations/provider`
 * routes. Exercises:
 *   - Owner-only authorization (non-Owners get 403).
 *   - GET / PUT round-trip with masking and partial-preserving writes.
 *   - Validate route — short-circuits in shared mode, calls the
 *     adapter in BYO mode.
 *   - Refusal of `mode=shared` switches when env var isn't set.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import createIntegrationProviderSettingsRoutes from './integration-provider-settings.js';
import { INTEGRATION_PROVIDERS_SCHEMA } from '../integration-provider-schema.js';
import { writeIntegrationProviderConfig, MASK } from '../integration-provider-store.js';
import { __resetPrEnvStoreForTests, __setPrEnvKeyFilePathForTests } from '../pr-env-store.js';
import type { Role } from '../roles.js';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

let db: Database.Database;
let keyDir: string;
let app: Express;
let role: Role;
let userId: string;

function stubRouteDeps(): RouteDeps {
  return {} as unknown as RouteDeps;
}

/**
 * Stub auth middleware — sets `authRole` and `authUserId` so the
 * production `requireRole('Owner')` guard in the router actually
 * exercises the role check. Toggle `role` in tests to flip between
 * Owner/Admin/User cases.
 */
function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthenticatedRequest).authRole = role;
  (req as AuthenticatedRequest).authUserId = userId;
  next();
}

type ValidateFn = (
  secretKey: string,
  baseUrl: string,
) => Promise<{
  ok: boolean;
  status?: number;
  message?: string;
  environment?: { name?: string; uniqueKey?: string };
}>;

function buildApp(opts: { sharedKey?: string; validateNangoKey?: ValidateFn } = {}): Express {
  const a = express();
  a.use(express.json());
  a.use(fakeAuth);
  a.use(
    createIntegrationProviderSettingsRoutes(stubRouteDeps(), {
      getDb: () => db,
      getSharedKey: () => opts.sharedKey,
      adapters: opts.validateNangoKey ? { validateNangoKey: opts.validateNangoKey } : undefined,
    }),
  );
  return a;
}

beforeEach(() => {
  keyDir = mkdtempSync(path.join(tmpdir(), 'int-prov-route-'));
  __setPrEnvKeyFilePathForTests(path.join(keyDir, 'key'));
  db = new Database(':memory:');
  db.exec(INTEGRATION_PROVIDERS_SCHEMA);
  role = 'Owner';
  userId = 'owner-1';
  app = buildApp();
});

afterEach(() => {
  db.close();
  rmSync(keyDir, { recursive: true, force: true });
  __resetPrEnvStoreForTests();
});

describe('authorization', () => {
  it('rejects non-Owner GET with 403', async () => {
    role = 'Admin';
    const res = await supertest(app).get('/api/admin/integrations/provider').expect(403);
    expect(res.body.requiredRole).toBe('Owner');
  });

  it('rejects non-Owner PUT with 403', async () => {
    role = 'User';
    await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'byo', secretKey: 'X' })
      .expect(403);
  });

  it('rejects non-Owner validate with 403', async () => {
    role = 'Admin';
    await supertest(app).post('/api/admin/integrations/provider/validate').send({}).expect(403);
  });

  it('allows Owner GET', async () => {
    const res = await supertest(app).get('/api/admin/integrations/provider').expect(200);
    expect(res.body.mode).toBe('shared');
  });
});

describe('GET /api/admin/integrations/provider', () => {
  it('returns empty defaults', async () => {
    const res = await supertest(app).get('/api/admin/integrations/provider').expect(200);
    expect(res.body).toMatchObject({
      mode: 'shared',
      provider: 'nango-cloud',
      hasKey: false,
      sharedAvailable: false,
      baseUrl: '',
      enabled: true,
    });
  });

  it('reports sharedAvailable when configured', async () => {
    const a = buildApp({ sharedKey: 'sk-shared' });
    // sharedAvailable is computed via the store from process.env, NOT
    // from the test override (the override only gates PUT/validate).
    const prev = process.env.HUB_SHARED_NANGO_KEY;
    process.env.HUB_SHARED_NANGO_KEY = 'sk-shared';
    try {
      const res = await supertest(a).get('/api/admin/integrations/provider').expect(200);
      expect(res.body.sharedAvailable).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HUB_SHARED_NANGO_KEY;
      else process.env.HUB_SHARED_NANGO_KEY = prev;
    }
  });

  it('masks BYO secret as hasKey=true and never returns plaintext', async () => {
    writeIntegrationProviderConfig(
      { mode: 'byo', secretKey: 'PLAINTEXT-SHOULD-NOT-LEAK', webhookSecret: 'wh' },
      'owner-1',
      db,
    );
    const res = await supertest(app).get('/api/admin/integrations/provider').expect(200);
    expect(res.body.hasKey).toBe(true);
    expect(res.body.hasWebhookSecret).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('PLAINTEXT-SHOULD-NOT-LEAK');
  });
});

describe('PUT /api/admin/integrations/provider', () => {
  it('writes a BYO config and returns masked view', async () => {
    const res = await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({
        mode: 'byo',
        provider: 'nango-cloud',
        secretKey: 'sk-1',
        providerBaseUrl: 'https://api.nango.dev',
      })
      .expect(200);
    expect(res.body.mode).toBe('byo');
    expect(res.body.hasKey).toBe(true);
    expect(res.body.baseUrl).toBe('https://api.nango.dev');
    // updated_by reflects the authenticated user.
    expect(res.body.updatedBy).toBe('owner-1');
  });

  it('preserves stored secret when MASK is sent', async () => {
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'ORIGINAL' }, 'owner-1', db);
    await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'byo', secretKey: MASK, providerBaseUrl: 'https://example.test' })
      .expect(200);
    const get = await supertest(app).get('/api/admin/integrations/provider').expect(200);
    expect(get.body.hasKey).toBe(true);
    expect(get.body.baseUrl).toBe('https://example.test');
    // The underlying ciphertext column must still be populated.
    const raw = db
      .prepare<
        unknown[],
        { secret_key_encrypted: string }
      >('SELECT secret_key_encrypted FROM integration_providers WHERE id = 1')
      .get();
    expect(raw?.secret_key_encrypted).not.toBe('');
  });

  it('rejects invalid mode', async () => {
    const res = await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'wrong' })
      .expect(400);
    expect(res.body.error).toMatch(/mode/);
  });

  it('rejects invalid provider', async () => {
    const res = await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({ provider: 'maton' })
      .expect(400);
    expect(res.body.error).toMatch(/provider/);
  });

  it('rejects non-string secret', async () => {
    const res = await supertest(app)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'byo', secretKey: 42 })
      .expect(400);
    expect(res.body.error).toMatch(/secretKey/);
  });

  it('refuses to switch to shared mode when env var is unset', async () => {
    const a = buildApp({ sharedKey: '' });
    const res = await supertest(a)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'shared' })
      .expect(400);
    expect(res.body.error).toMatch(/HUB_SHARED_NANGO_KEY/);
  });

  it('allows the switch to shared mode when env var is set', async () => {
    const a = buildApp({ sharedKey: 'present' });
    const res = await supertest(a)
      .put('/api/admin/integrations/provider')
      .send({ mode: 'shared' })
      .expect(200);
    expect(res.body.mode).toBe('shared');
    expect(res.body.hasKey).toBe(false);
  });
});

describe('POST /api/admin/integrations/provider/validate', () => {
  it('short-circuits ok=true in shared mode with env var set', async () => {
    const a = buildApp({ sharedKey: 'present' });
    const res = await supertest(a)
      .post('/api/admin/integrations/provider/validate')
      .send({ mode: 'shared' })
      .expect(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mode).toBe('shared');
  });

  it('returns ok=false in shared mode when env var is unset', async () => {
    const a = buildApp({ sharedKey: '' });
    const res = await supertest(a)
      .post('/api/admin/integrations/provider/validate')
      .send({ mode: 'shared' })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.message).toMatch(/HUB_SHARED_NANGO_KEY/);
  });

  it('calls the Nango adapter in BYO mode with the candidate secret', async () => {
    const seen: { key?: string; baseUrl?: string } = {};
    const a = buildApp({
      validateNangoKey: async (key, baseUrl) => {
        seen.key = key;
        seen.baseUrl = baseUrl;
        return { ok: true, status: 200, environment: { name: 'dev' } };
      },
    });
    const res = await supertest(a)
      .post('/api/admin/integrations/provider/validate')
      .send({
        mode: 'byo',
        secretKey: 'try-this',
        providerBaseUrl: 'https://api.nango.dev',
      })
      .expect(200);
    expect(seen.key).toBe('try-this');
    expect(seen.baseUrl).toBe('https://api.nango.dev');
    expect(res.body.ok).toBe(true);
    expect(res.body.environment.name).toBe('dev');
  });

  it('falls back to the saved secret when caller sends MASK', async () => {
    writeIntegrationProviderConfig({ mode: 'byo', secretKey: 'STORED' }, '', db);
    const seen: { key?: string } = {};
    const a = buildApp({
      validateNangoKey: async (key) => {
        seen.key = key;
        return { ok: true, status: 200 };
      },
    });
    await supertest(a)
      .post('/api/admin/integrations/provider/validate')
      .send({ mode: 'byo', secretKey: MASK })
      .expect(200);
    expect(seen.key).toBe('STORED');
  });

  it('reports adapter failure with status + message', async () => {
    const a = buildApp({
      validateNangoKey: async () => ({
        ok: false,
        status: 401,
        message: 'Nango 401: invalid key',
      }),
    });
    const res = await supertest(a)
      .post('/api/admin/integrations/provider/validate')
      .send({ mode: 'byo', secretKey: 'bad' })
      .expect(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe(401);
    expect(res.body.message).toMatch(/invalid key/);
  });
});
