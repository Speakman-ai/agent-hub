/**
 * Integration tests for the apiKey → JWT migration path.
 *
 * The scenario is a deployment that has been running on `config.apiKey`
 * alone (no `auth.json` on disk). The client needs two things so it can
 * surface the "upgrade my auth" banner and drive the upgrade to
 * completion:
 *
 *   1. `GET /api/auth/status` reports `needsMigration: true` while the
 *      server is in the apiKey-only state, and flips to `false` once
 *      `POST /api/auth/setup` has written `auth.json`.
 *
 *   2. `POST /api/auth/setup` with `X-API-Key: <key>` (and no bearer) is
 *      allowed through the middleware, creates the Owner user, and —
 *      critically — seeds an Owner membership in **every** pre-existing
 *      org (not just `default`). A multi-org install that upgrades with
 *      only a `default` membership would lock the Owner out of the other
 *      orgs on the next login.
 *
 * These paths are already wired up in the product — the tests lock the
 * behavior in so the contract the client depends on can't silently
 * regress.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: { apiKey: string | null; dataDir: string } = {
  apiKey: null,
  get dataDir() {
    return TMP_DIR;
  },
} as { apiKey: string | null; dataDir: string };

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, getOrgsDb, updateOrg } =
  await import('../orgs.js');
const { getUserByUsername, countUsers } = await import('../users-store.js');
const { getMembershipRole } = await import('../memberships-store.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  return app;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-migration-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // These tests validate the apiKey→JWT migration gate. The default-
  // seeded org is mode='local', which would short-circuit the
  // middleware via the local-bypass (card 3d72338d) and hide the gate
  // we want to exercise. Flip it to 'remote' so the apiKey path is
  // actually enforced for the whole suite.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('GET /api/auth/status — migration signal', () => {
  it('returns needsMigration=true in the apiKey-only state', async () => {
    mockConfig.apiKey = 'legacy-shared-secret';
    // auth.json does not exist — `authConfigured: false`.
    const res = await supertest(buildGatedApp()).get('/api/auth/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      authConfigured: false,
      jwtConfigured: false,
      apiKeyConfigured: true,
      needsMigration: true,
    });
  });

  it('returns needsMigration=false once /api/auth/setup has run', async () => {
    mockConfig.apiKey = 'legacy-shared-secret';
    const app = buildGatedApp();

    const setup = await supertest(app)
      .post('/api/auth/setup')
      .set('X-API-Key', 'legacy-shared-secret')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(setup.status).toBe(200);
    reloadAuthRecord();

    const res = await supertest(app).get('/api/auth/status');
    expect(res.body).toMatchObject({
      authConfigured: true,
      jwtConfigured: true,
      // apiKey is still set on the server — it stays as break-glass.
      apiKeyConfigured: true,
      needsMigration: false,
      role: 'Owner',
    });
  });

  it('returns needsMigration=false on a clean install (no apiKey, no auth.json)', async () => {
    mockConfig.apiKey = null;
    const res = await supertest(buildGatedApp()).get('/api/auth/status');
    // No apiKey + no JWT is a fresh install — the SetupWizard handles this,
    // not the migration banner. needsMigration must be false so the banner
    // doesn't flash on a brand-new server.
    expect(res.body).toMatchObject({
      authConfigured: false,
      jwtConfigured: false,
      apiKeyConfigured: false,
      needsMigration: false,
    });
  });
});

describe('POST /api/auth/setup — apiKey→JWT migration', () => {
  it('creates the Owner user and seeds membership in every pre-existing org', async () => {
    mockConfig.apiKey = 'legacy-shared-secret';

    // Two orgs already exist on disk (the common "default + one team" layout)
    // — the migration must seed Owner in both, not just `default`.
    createOrg({ id: 'default', name: 'Default' });
    createOrg({ id: 'team-alpha', name: 'Team Alpha' });

    // Sanity: no users before setup runs.
    expect(countUsers()).toBe(0);

    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .set('X-API-Key', 'legacy-shared-secret')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // JWT shape: three base64url segments separated by dots.
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.token.split('.')).toHaveLength(3);
    expect(res.body.user).toMatchObject({ email: 'owner@example.com', role: 'Owner' });
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // users table populated with exactly one row.
    const owner = getUserByUsername('owner@example.com');
    expect(owner).not.toBeNull();
    expect(countUsers()).toBe(1);
    // The response also carries the new user row's id so clients can match
    // themselves against per-user fields on broadcasts (e.g. `ownerUserId`).
    expect(res.body.user.id).toBe(owner!.id);

    // memberships table populated — Owner in **every** pre-existing org.
    expect(getMembershipRole(owner!.id, 'default')).toBe('Owner');
    expect(getMembershipRole(owner!.id, 'team-alpha')).toBe('Owner');

    const membershipRows = getOrgsDb()
      .prepare('SELECT org_id, role FROM memberships WHERE user_id = ? ORDER BY org_id')
      .all(owner!.id) as Array<{ org_id: string; role: string }>;
    expect(membershipRows).toEqual([
      { org_id: 'default', role: 'Owner' },
      { org_id: 'team-alpha', role: 'Owner' },
    ]);
  });

  it('409s if setup is re-run after migration', async () => {
    mockConfig.apiKey = 'legacy-shared-secret';
    const app = buildGatedApp();

    const first = await supertest(app)
      .post('/api/auth/setup')
      .set('X-API-Key', 'legacy-shared-secret')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(first.status).toBe(200);
    reloadAuthRecord();

    const second = await supertest(app)
      .post('/api/auth/setup')
      .set('X-API-Key', 'legacy-shared-secret')
      .send({ email: 'impostor@example.com', password: 'takeover-password' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already configured/i);
  });

  it('rejects setup without X-API-Key when apiKey is configured', async () => {
    mockConfig.apiKey = 'legacy-shared-secret';
    const res = await supertest(buildGatedApp())
      .post('/api/auth/setup')
      .send({ email: 'impostor@example.com', password: 'takeover-password' });
    // Middleware refuses the request before the route handler runs, so
    // no auth.json gets written.
    expect(res.status).toBe(401);
    expect(countUsers()).toBe(0);
  });
});
