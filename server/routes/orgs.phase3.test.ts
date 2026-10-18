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
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import type { AuthenticatedRequest } from '../auth.js';
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
const {
  initOrgsDb,
  setOrgsDbPathForTests,
  createOrg,
  updateOrg,
  getOrgsDb,
  getAllOrgs,
  getActiveOrgId,
  setActiveOrgId,
  orgDataDir,
} = await import('../orgs.js');
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
  app.use((req, _res, next) => {
    const observer = overrides.observeAuth as ((req: AuthenticatedRequest) => void) | undefined;
    observer?.(req as AuthenticatedRequest);
    next();
  });
  app.use(createOrgRoutes(deps));
  app.use(createAuthRoutes());
  return app;
}

async function seedOwnerAndLogin(app: ReturnType<typeof buildApp>) {
  const setup = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'a-strong-password' });
  return setup.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'orgs-phase3-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // Use a remote connection fixture; deployment auth is controlled by
  // AGENT_HUB_MODE, not the editable connection mode.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe.each(['/api/orgs', '/api/servers'])('%s permissions', (base) => {
  describe('GET /api/orgs/:id/members', () => {
    it('returns members to an Admin of the org', async () => {
      const app = buildApp();
      const token = await seedOwnerAndLogin(app);

      const res = await supertest(app)
        .get(`${base}/default/members`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(
        res.body.members.some((m: { username: string }) => m.username === 'owner@example.com'),
      ).toBe(true);
      expect(res.body[base === '/api/servers' ? 'serverId' : 'orgId']).toBe('default');
    });

    it('rejects members list from a non-member with 403', async () => {
      const app = buildApp();
      await seedOwnerAndLogin(app);

      // Seed a second org that our owner does NOT belong to, but with a
      // different user as Owner so it's listable by that user only.
      createOrg({ id: 'team-b', name: 'Team B' });
      const stranger = (await import('../users-store.js')).createUser({
        username: 'stranger@example.com',
        passwordHash: 'h',
      });
      createMembership(stranger.id, 'team-b', 'Owner');

      // Log in as owner (who only has membership in default) and try to
      // peek into team-b.
      const login = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'owner@example.com', password: 'a-strong-password' });
      const ownerToken: string = login.body.token;

      const res = await supertest(app)
        .get(`${base}/team-b/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });
  });

  describe('POST /api/orgs grants Owner membership to the creator', () => {
    it('owner who creates a new org is seeded as Owner of it', async () => {
      const app = buildApp();
      const token = await seedOwnerAndLogin(app);
      const owner = getUserByUsername('owner@example.com')!;

      const res = await supertest(app)
        .post(base)
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
        .send({ email: 'peon@example.com', password: 'peons-super-strong-password', role: 'User' });
      const login = await supertest(app)
        .post('/api/auth/login')
        .send({ email: 'peon@example.com', password: 'peons-super-strong-password' });
      const peonToken: string = login.body.token;

      const res = await supertest(app)
        .post(base)
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
        .post(`${base}/foreign/switch`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });

    it('allows switching to an org the caller is a member of', async () => {
      const app = buildApp();
      const ownerToken = await seedOwnerAndLogin(app);
      const owner = getUserByUsername('owner@example.com')!;
      createOrg({ id: 'home', name: 'Home' });
      createMembership(owner.id, 'home', 'Owner');

      const res = await supertest(app)
        .post(`${base}/home/switch`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        [base === '/api/servers' ? 'serverId' : 'orgId']: 'home',
      });
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
      const owner = getUserByUsername('owner@example.com')!;
      createOrg({ id: 'resilient', name: 'Resilient' });
      createMembership(owner.id, 'resilient', 'Owner');

      const res = await supertest(app)
        .post(`${base}/resilient/switch`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        [base === '/api/servers' ? 'serverId' : 'orgId']: 'resilient',
      });
    });

    it('still switches (200) when ensureSkillBuilderAgents dep is missing', async () => {
      // Exact reproduction of the original CI failure: a deps object that does
      // not supply ensureSkillBuilderAgents (undefined → "is not a function"
      // when the backfill invokes it). performOrgSwitch must swallow it and
      // return 200, not 500.
      const app = buildApp({ ensureSkillBuilderAgents: undefined });
      const ownerToken = await seedOwnerAndLogin(app);
      const owner = getUserByUsername('owner@example.com')!;
      createOrg({ id: 'no-dep', name: 'No Dep' });
      createMembership(owner.id, 'no-dep', 'Owner');

      const res = await supertest(app)
        .post(`${base}/no-dep/switch`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        [base === '/api/servers' ? 'serverId' : 'orgId']: 'no-dep',
      });
    });
  });

  describe('DELETE /api/orgs/:id — Owner required', () => {
    it('non-Owner cannot delete an org even if they are a member', async () => {
      const app = buildApp();
      const ownerToken = await seedOwnerAndLogin(app);
      createOrg({ id: 'co-op', name: 'Co-op' });
      const owner = getUserByUsername('owner@example.com')!;
      createMembership(owner.id, 'co-op', 'Admin'); // Admin, not Owner

      const res = await supertest(app)
        .delete(`${base}/co-op`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(403);
    });
  });
});

describe('Server API compatibility', () => {
  it.each(['/api/server/switch/', '/api/SeRvEr/SwItCh', '/api/SeRvEr/SwItCh/'])(
    'keeps Server body-switch semantics for %s',
    async (endpoint) => {
      const app = buildApp();
      const response = await supertest(app)
        .post(endpoint)
        .send({ serverId: 'default' })
        .expect(200);
      expect(response.body).toEqual({ ok: true, serverId: 'default', projects: 0, agents: 0 });
      await supertest(app).post(endpoint).send({ orgId: 'default' }).expect(400);
    },
  );

  it.each(['/api/servers', '/api/SeRvErS', '/api/SeRvErS/'])(
    'keeps Server DTOs and validation for %s',
    async (base) => {
      const app = buildApp();
      const list = await supertest(app).get(base).expect(200);
      expect(list.body[0]).toHaveProperty('remoteUrl');
      expect(list.body[0]).not.toHaveProperty('remote_url');
      const prefix = base.replace(/\/$/, '');
      const members = await supertest(app).get(`${prefix}/default/MeMbErS/`).expect(200);
      expect(members.body).toEqual({ serverId: 'default', members: [] });
      const switched = await supertest(app).post(`${prefix}/default/SwItCh/`).expect(200);
      expect(switched.body).toEqual({ ok: true, serverId: 'default', projects: 0, agents: 0 });
      await supertest(app).put(`${prefix}/default/`).send({ position: 'invalid' }).expect(400);
    },
  );

  it('preserves legacy response shapes for case and trailing-slash variants', async () => {
    const app = buildApp();
    const list = await supertest(app).get('/api/OrGs/').expect(200);
    expect(list.body[0]).toHaveProperty('remote_url');
    expect(list.body[0]).not.toHaveProperty('remoteUrl');
    const switched = await supertest(app)
      .post('/api/OrG/SwItCh/')
      .send({ orgId: 'default' })
      .expect(200);
    expect(switched.body).toEqual({ ok: true, orgId: 'default', projects: 0, agents: 0 });
  });

  it('adapts CRUD responses while legacy clients see the same persisted record', async () => {
    const app = buildApp();
    const saved = {
      id: 'saved-remote',
      name: 'Remote',
      mode: 'remote',
      remoteUrl: 'https://hub.example.test',
      apiKey: 'fixture-only-key',
      color: '#112233',
    };
    const created = await supertest(app).post('/api/servers').send(saved).expect(201);
    expect(created.body).toMatchObject(saved);
    expect(created.body).not.toHaveProperty('remote_url');
    expect(created.body).not.toHaveProperty('api_key');
    expect(created.body.createdAt).toEqual(expect.any(String));
    const legacy = await supertest(app).get('/api/orgs/saved-remote').expect(200);
    expect(legacy.body).toMatchObject({
      id: saved.id,
      remote_url: saved.remoteUrl,
      api_key: saved.apiKey,
      created_at: created.body.createdAt,
    });
    expect(legacy.body).not.toHaveProperty('remoteUrl');
    await supertest(app)
      .put('/api/orgs/saved-remote')
      .send({ name: 'Renamed by old client' })
      .expect(200);
    const updated = await supertest(app)
      .put('/api/servers/saved-remote')
      .send({ position: 4, remoteUrl: 'https://new.example.test' })
      .expect(200);
    expect(updated.body).toMatchObject({
      id: saved.id,
      name: 'Renamed by old client',
      position: 4,
      remoteUrl: 'https://new.example.test',
      apiKey: saved.apiKey,
    });
    const list = await supertest(app).get('/api/servers').expect(200);
    expect(list.body.find((row: { id: string }) => row.id === saved.id)).toEqual(updated.body);
    await supertest(app).delete('/api/servers/saved-remote').expect(200);
    await supertest(app).get('/api/orgs/saved-remote').expect(404);
    await supertest(app)
      .delete('/api/servers/default')
      .expect(400, { error: 'Cannot delete the last server' });
  });

  it('reopens saved legacy IDs, credentials, memberships and active partition with the same JWT', async () => {
    const initDb = vi.fn();
    const reloadProjects = vi.fn();
    const setActiveDataDir = vi.fn();
    const broadcast = vi.fn();
    const scheduleAll = vi.fn();
    let context: Pick<AuthenticatedRequest, 'authUserId' | 'authOrgId' | 'authRole'> = {};
    const app = buildApp({
      initDb,
      reloadProjects,
      setActiveDataDir,
      broadcast,
      scheduleAll,
      observeAuth: (req: AuthenticatedRequest) => {
        context = { authUserId: req.authUserId, authOrgId: req.authOrgId, authRole: req.authRole };
      },
    });
    const token = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner@example.com')!;
    // Fixture uses the persisted legacy column names and stable IDs, as an
    // existing installation does. No Server DTO is written to the database.
    getOrgsDb()
      .prepare(
        `INSERT INTO orgs (id, name, mode, color, remote_url, api_key, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'saved-server-id',
        'Saved remote',
        'remote',
        '#abcdef',
        'https://saved.example.test',
        'saved-fixture-key',
        7,
        '2025-01-02 03:04:05',
        '2025-02-03 04:05:06',
      );
    updateOrg('default', { mode: 'local' });
    createMembership(owner.id, 'saved-server-id', 'Admin');
    setActiveOrgId('saved-server-id');
    const before = getAllOrgs();
    const projects = '[{"id":"existing-project","name":"Existing"}]\n';
    writeFileSync(path.join(TMP_DIR, 'projects.json'), projects);
    const authBefore = readFileSync(path.join(TMP_DIR, 'auth.json'), 'utf8');
    const tablesBefore = getOrgsDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all();

    setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
    initOrgsDb();
    reloadAuthRecord();
    expect(getAllOrgs()).toEqual(before);
    expect(getActiveOrgId()).toBe('saved-server-id');
    expect(
      getOrgsDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(),
    ).toEqual(tablesBefore);
    expect(readFileSync(path.join(TMP_DIR, 'projects.json'), 'utf8')).toBe(projects);
    expect(readFileSync(path.join(TMP_DIR, 'auth.json'), 'utf8')).toBe(authBefore);
    const server = await supertest(app)
      .get('/api/servers/saved-server-id')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(server.body).toMatchObject({
      id: 'saved-server-id',
      remoteUrl: 'https://saved.example.test',
      apiKey: 'saved-fixture-key',
      createdAt: '2025-01-02 03:04:05',
    });
    expect(context).toEqual({
      authUserId: owner.id,
      authOrgId: 'saved-server-id',
      authRole: 'Admin',
    });
    const members = await supertest(app)
      .get('/api/servers/saved-server-id/members')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(members.body).toMatchObject({
      serverId: 'saved-server-id',
      members: [expect.objectContaining({ id: owner.id, role: 'Admin' })],
    });
    expect(members.body).not.toHaveProperty('orgId');

    // An already-active switch must not reinitialize schedulers or databases.
    await supertest(app)
      .post('/api/servers/saved-server-id/switch')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(initDb).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    const switched = await supertest(app)
      .post('/api/server/switch')
      .set('Authorization', `Bearer ${token}`)
      .send({ serverId: 'default' })
      .expect(200);
    expect(switched.body).toEqual({ ok: true, serverId: 'default', projects: 0, agents: 0 });
    expect(initDb).toHaveBeenCalledExactlyOnceWith(orgDataDir('default'));
    expect(reloadProjects).toHaveBeenCalledExactlyOnceWith(orgDataDir('default'));
    expect(setActiveDataDir).toHaveBeenCalledExactlyOnceWith(orgDataDir('default'));
    expect(scheduleAll).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledExactlyOnceWith({
      type: 'org_switched',
      orgId: 'default',
      dataDir: orgDataDir('default'),
    });
    expect(getActiveOrgId()).toBe('default');
    await supertest(app)
      .get('/api/orgs/default/members')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(context).toEqual({ authUserId: owner.id, authOrgId: 'default', authRole: 'Owner' });
    expect(getAllOrgs()).toEqual(before);
    expect(readFileSync(path.join(TMP_DIR, 'projects.json'), 'utf8')).toBe(projects);
  });

  it('keeps API-key and no-auth mode access on both vocabularies', async () => {
    const app = buildApp();
    mockConfig.apiKey = 'fixture-global-key';
    for (const base of ['/api/orgs', '/api/servers']) {
      await supertest(app).get(base).expect(401);
      await supertest(app)
        .get(`${base}/default/members`)
        .set('X-API-Key', 'fixture-global-key')
        .expect(200);
      await supertest(app)
        .post(`${base}/default/switch`)
        .set('X-API-Key', 'fixture-global-key')
        .expect(200);
    }
    mockConfig.apiKey = null;
    await supertest(app).post('/api/server/switch').send({ serverId: 'default' }).expect(200);
    await supertest(app).post('/api/org/switch').send({ orgId: 'default' }).expect(200);
  });

  it('gates both switch aliases by target membership and preserves User roles', async () => {
    const initDb = vi.fn();
    const app = buildApp({ initDb });
    const token = await seedOwnerAndLogin(app);
    const owner = getUserByUsername('owner@example.com')!;
    createOrg({ id: 'target', name: 'Target', mode: 'remote' });
    for (const endpoint of ['/api/servers/target/switch', '/api/server/switch']) {
      await supertest(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId: 'target' })
        .expect(403, { error: 'You are not a member of this server.' });
    }
    expect(initDb).not.toHaveBeenCalled();
    expect(getActiveOrgId()).toBe('default');
    createMembership(owner.id, 'target', 'User');
    // Mark active without filesystem initialization; both handlers must honor
    // membership and their no-op behavior for an ordinary User as well.
    setActiveOrgId('target');
    for (const endpoint of ['/api/servers/target/switch', '/api/server/switch']) {
      await supertest(app)
        .post(endpoint)
        .set('Authorization', `Bearer ${token}`)
        .send({ serverId: 'target' })
        .expect(200);
    }
    await supertest(app)
      .get('/api/servers/target/members')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    await supertest(app)
      .delete('/api/servers/target')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
    expect(getMembershipRole(owner.id, 'target')).toBe('User');
  });

  it('preserves Electron bundled-local bypass with configured auth', async () => {
    const app = buildApp();
    mockConfig.apiKey = 'fixture-configured-key';
    vi.stubEnv('AGENT_HUB_MODE', 'local');
    try {
      for (const base of ['/api/orgs', '/api/servers']) {
        await supertest(app).get(`${base}/default/members`).expect(200);
        await supertest(app).post(`${base}/default/switch`).expect(200);
      }
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects invalid new requests and unknown servers without changing active state', async () => {
    const app = buildApp();
    for (const body of [{}, { name: 'Invalid', mode: 'other' }, { name: 42 }]) {
      await supertest(app).post('/api/servers').send(body).expect(400);
    }
    await supertest(app).put('/api/servers/default').send({ position: 'invalid' }).expect(400);
    await supertest(app).post('/api/server/switch').send({ orgId: 'default' }).expect(400);
    await supertest(app).post('/api/server/switch').send({ serverId: 'missing' }).expect(404);
    await supertest(app).post('/api/servers/missing/switch').expect(404);
    expect(getActiveOrgId()).toBe('default');
    expect(getAllOrgs()).toHaveLength(1);
    await supertest(app).get('/api/organizations').expect(404);
  });
});
