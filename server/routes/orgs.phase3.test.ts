/**
 * Phase 3 membership gating for the org routes.
 *
 * Covers the three additions: members list, switch gating, and
 * Owner-seeding on create. Keeps the dep stubs minimal since the switch
 * handler doesn't care about most of them — we just need the no-op
 * callables so `performOrgSwitch` doesn't throw.
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

const { default: createOrgRoutes } = await import('./orgs.js');
const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, updateOrg } = await import('../orgs.js');
const { getUserByUsername } = await import('../users-store.js');
const { createMembership, getMembershipRole } = await import('../memberships-store.js');

function buildApp(overrides: Record<string, unknown> = {}) {
  // Minimal RouteDeps stub. The switch handler reaches into most of these,
  // but we only need no-ops that don't throw — the gate rejects before
  // any of them are called for the failure cases we're testing, and
  // the Owner path goes through but we stub everything to no-op.
  const deps = {
    initDb: () => {},
    broadcast: () => {},
    allAgents: () => [],
    reloadProjects: () => {},
    getProjects: () => [],
    autonomousCrons: new Map(),
    restoreAutonomousCrons: () => {},
    setActiveDataDir: () => {},
    scheduleAll: () => {},
    ensureSkillBuilderAgents: () => {},
    ...overrides,
  } as unknown as Parameters<typeof createOrgRoutes>[0];

  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createOrgRoutes(deps));
  app.use(createAuthRoutes());
  return app;
}

async function seedOwnerAndLogin(app: ReturnType<typeof buildApp>) {
  const setup = await supertest(app)
    .post('/api/auth/setup')
    .send({ username: 'owner', password: 'a-strong-password' });
  return setup.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'orgs-phase3-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // These integration tests validate JWT / Owner / membership auth
  // enforcement. The default-seeded org is mode='local', which would
  // short-circuit the middleware via the local-bypass (card 3d72338d)
  // and hide the gate we want to test. Flip it to 'remote' so the
  // middleware exercises the real auth path for the whole suite.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('GET /api/orgs/:id/members', () => {
  it('returns members to an Admin of the org', async () => {
    const app = buildApp();
    const token = await seedOwnerAndLogin(app);

    const res = await supertest(app)
      .get('/api/orgs/default/members')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.members.some((m: { username: string }) => m.username === 'owner')).toBe(true);
    expect(res.body.orgId).toBe('default');
  });

  it('rejects members list from a non-member with 403', async () => {
    const app = buildApp();
    await seedOwnerAndLogin(app);

    // Seed a second org that our owner does NOT belong to, but with a
    // different user as Owner so it's listable by that user only.
    createOrg({ id: 'team-b', name: 'Team B' });
    const stranger = (await import('../users-store.js')).createUser({
      username: 'stranger',
      passwordHash: 'h',
    });
    createMembership(stranger.id, 'team-b', 'Owner');

    // Log in as owner (who only has membership in default) and try to
    // peek into team-b.
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ username: 'owner', password: 'a-strong-password' });
    const ownerToken: string = login.body.token;

    const res = await supertest(app)
      .get('/api/orgs/team-b/members')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/orgs grants Owner membership to the creator', () => {
  it('owner who creates a new org is seeded as Owner of it', async () => {
    const app = buildApp();
    const token = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner')!;

    const res = await supertest(app)
      .post('/api/orgs')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Team C' });
    expect(res.status).toBe(201);
    const newOrgId = res.body.id;
    expect(getMembershipRole(owner.id, newOrgId)).toBe('Owner');
  });

  it('rejects org creation when caller is not Owner of active org', async () => {
    const app = buildApp();
    const ownerToken = await seedOwnerAndLogin(app);

    // Create a User
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ username: 'peon', password: 'peons-super-strong-password', role: 'User' });
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ username: 'peon', password: 'peons-super-strong-password' });
    const peonToken: string = login.body.token;

    const res = await supertest(app)
      .post('/api/orgs')
      .set('Authorization', `Bearer ${peonToken}`)
      .send({ name: 'Rogue Org' });
    expect(res.status).toBe(403);
  });
});

describe('POST /api/orgs/:id/switch — membership gating', () => {
  it('rejects switching to an org the caller is not a member of', async () => {
    const app = buildApp();
    const ownerToken = await seedOwnerAndLogin(app);
    // Seed an org the owner is NOT a member of.
    createOrg({ id: 'foreign', name: 'Foreign' });

    const res = await supertest(app)
      .post('/api/orgs/foreign/switch')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });

  it('allows switching to an org the caller is a member of', async () => {
    const app = buildApp();
    const ownerToken = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner')!;
    createOrg({ id: 'home', name: 'Home' });
    createMembership(owner.id, 'home', 'Owner');

    const res = await supertest(app)
      .post('/api/orgs/home/switch')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orgId: 'home' });
  });

  it('still switches (200) when the Skill Builder backfill throws', async () => {
    // The backfill is best-effort: a seeding/marker-write failure inside
    // performOrgSwitch must NOT 500 the switch (the UI switches to the active
    // org on every connect). Force the backfill to throw and assert the
    // switch still succeeds.
    const app = buildApp({
      ensureSkillBuilderAgents: () => {
        throw new Error('backfill boom');
      },
    });
    const ownerToken = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner')!;
    createOrg({ id: 'resilient', name: 'Resilient' });
    createMembership(owner.id, 'resilient', 'Owner');

    const res = await supertest(app)
      .post('/api/orgs/resilient/switch')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orgId: 'resilient' });
  });

  it('still switches (200) when ensureSkillBuilderAgents dep is missing', async () => {
    // Exact reproduction of the original CI failure: a deps object that does
    // not supply ensureSkillBuilderAgents (undefined → "is not a function"
    // when the backfill invokes it). performOrgSwitch must swallow it and
    // return 200, not 500.
    const app = buildApp({ ensureSkillBuilderAgents: undefined });
    const ownerToken = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner')!;
    createOrg({ id: 'no-dep', name: 'No Dep' });
    createMembership(owner.id, 'no-dep', 'Owner');

    const res = await supertest(app)
      .post('/api/orgs/no-dep/switch')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, orgId: 'no-dep' });
  });
});

describe('DELETE /api/orgs/:id — Owner required', () => {
  it('non-Owner cannot delete an org even if they are a member', async () => {
    const app = buildApp();
    const ownerToken = await seedOwnerAndLogin(app);
    createOrg({ id: 'co-op', name: 'Co-op' });
    const owner = getUserByUsername('owner')!;
    createMembership(owner.id, 'co-op', 'Admin'); // Admin, not Owner

    const res = await supertest(app)
      .delete('/api/orgs/co-op')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(403);
  });
});
