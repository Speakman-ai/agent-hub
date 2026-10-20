import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Request } from 'express';
import request from 'supertest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AuthenticatedRequest } from '../auth.js';
import type { Project } from '../types.js';
import {
  initOrgsDb,
  getOrgsDb,
  setOrgsDbPathForTests,
  orgDataDir,
  getActiveOrgId,
} from '../orgs.js';
import { setAuthFilePathForTests } from '../auth-store.js';
import { setProjects, getProjects } from '../project-model.js';
import { createMembership, deleteMembership, setMembershipRole } from '../memberships-store.js';
import { addProjectMember, removeProjectMember } from '../project-members-store.js';
import {
  attachBusinessOrganizationProject,
  createBusinessOrganization,
  getBusinessOrganization,
  listBusinessOrganizationMembers,
  listBusinessOrganizationProjectIds,
  setBusinessOrganizationMember,
} from '../business-organizations-store.js';
import { canReadOrganizationEvent } from '../business-organizations-access.js';
import { shouldDeliverBroadcast } from '../broadcast-filter.js';
import createOrganizationsRoutes from './organizations.js';
import { Organization, OrganizationMember, OrganizationProject } from './organizations.openapi.js';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('../orgs.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../orgs.js')>()),
  orgDataDir: (id: string) => path.join(fixture.directory, id),
}));
const broadcast = vi.fn();
let organizationId: string;
let foreignId: string;
const url = () => `/api/organizations/${organizationId}`;
function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: id, cwd: '/private/path', ahw: '', agents: [], ...extra };
}
function app(userId?: string, serverId = 'default', claims: Partial<AuthenticatedRequest> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, { authUserId: userId, authOrgId: serverId, authRole: 'Owner', ...claims });
    next();
  });
  app.use(createOrganizationsRoutes({ broadcast }));
  // Do not expose DB/filesystem details on unexpected errors.
  app.use((_error: unknown, _req: Request, res: express.Response, _next: express.NextFunction) =>
    res.status(500).json({ error: 'Internal error' }),
  );
  return app;
}
function delivered(event: Record<string, unknown>, userId: string, serverId = 'default') {
  return shouldDeliverBroadcast(
    event,
    { userId, serverId, role: 'Owner' },
    {
      resolveProjectId: () => null,
      findProject: () => null,
      getSessionOwner: () => null,
      canReadOrganizationEvent,
    },
  );
}

beforeEach(() => {
  fixture.directory = mkdtempSync(path.join(os.tmpdir(), 'organizations-api-'));
  setAuthFilePathForTests(path.join(fixture.directory, 'auth.json'));
  setOrgsDbPathForTests(path.join(fixture.directory, 'orgs.db'));
  initOrgsDb();
  getOrgsDb().exec(
    "INSERT INTO orgs (id, name) VALUES ('other', 'Other'); INSERT INTO orgs (id, name, mode) VALUES ('remote', 'Remote', 'remote');",
  );
  for (const id of [
    'creator',
    'org-admin',
    'member',
    'nonmember',
    'server-admin',
    'server-owner',
    'outsider',
    'foreign-user',
  ]) {
    getOrgsDb()
      .prepare('INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)')
      .run(id, id, 'unused');
    if (!['outsider', 'foreign-user'].includes(id))
      createMembership(
        id,
        'default',
        id === 'server-admin' ? 'Admin' : id === 'server-owner' ? 'Owner' : 'User',
      );
  }
  createMembership('creator', 'other', 'Owner');
  createMembership('foreign-user', 'other', 'User');
  setProjects([
    project('shared'),
    project('independent'),
    project('private', { visibility: 'private', ownerUserId: 'creator' }),
    project('restricted'),
    project('hidden', { hidden: true }),
    project('internal', { internal: true }),
    project('__hub__'),
    project('system', { kind: 'system' }),
  ]);
  mkdirSync(orgDataDir('other'), { recursive: true });
  writeFileSync(
    path.join(orgDataDir('other'), 'projects.json'),
    JSON.stringify([
      project('foreign'),
      project('shared', { name: 'Other Server shared project' }),
    ]),
  );
  organizationId = createBusinessOrganization({
    serverId: 'default',
    name: 'Acme',
    createdBy: 'creator',
  }).id;
  foreignId = createBusinessOrganization({
    serverId: 'other',
    name: 'Foreign Organization',
    createdBy: 'creator',
  }).id;
  setBusinessOrganizationMember('default', organizationId, 'org-admin', 'Admin');
  setBusinessOrganizationMember('default', organizationId, 'member', 'Member');
  addProjectMember('restricted', 'creator', 'creator');
  for (const id of ['shared', 'private', 'restricted'])
    attachBusinessOrganizationProject('default', organizationId, id);
  broadcast.mockClear();
});
afterEach(() => {
  setProjects([]);
  setOrgsDbPathForTests(null);
  setAuthFilePathForTests(null);
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe('organization management permission matrix', () => {
  it.each([
    [undefined, 401, 401],
    ['outsider', 404, 404],
    ['nonmember', 404, 404],
    ['member', 200, 403],
    ['org-admin', 200, 200],
    ['creator', 200, 200],
    ['server-admin', 200, 200],
    ['server-owner', 200, 200],
  ] as const)('%s reads with %i and manages with %i', async (userId, read, manage) => {
    const client = request(app(userId));
    for (const suffix of ['', '/members', '/projects'])
      await client.get(`${url()}${suffix}`).expect(read);
    await client.patch(url()).send({ name: 'Renamed' }).expect(manage);
    await client.put(`${url()}/members/nonmember`).send({ role: 'Member' }).expect(manage);
    await client.put(`${url()}/projects/independent`).expect(manage);
    await client.delete(`${url()}/projects/shared`).expect(manage);
    await client.delete(`${url()}/members/member`).expect(manage);
    await client.delete(url()).expect(manage);
    if (manage !== 200) expect(broadcast).not.toHaveBeenCalled();
  });

  it('requires a real user even with a global key and a session header', async () => {
    for (const claims of [
      { authViaApiKey: true },
      { authLocalOrgBypass: true },
      { authRole: 'Owner' as const },
    ]) {
      await request(app(undefined, 'default', claims))
        .post('/api/organizations')
        .set('x-agent-hub-session-id', 'claimed-session')
        .send({ name: 'Forged' })
        .expect(401);
    }
    await request(app('creator', '', {}))
      .get('/api/organizations')
      .expect(401);
  });

  it('creates with an independent Owner role and returns only visible groups without counts', async () => {
    const response = await request(app('nonmember'))
      .post('/api/organizations')
      .send({ name: '  New Group  ' })
      .expect(201);
    expect(Organization.safeParse(response.body.organization).success).toBe(true);
    expect(response.body.organization).toMatchObject({
      serverId: 'default',
      name: 'New Group',
      role: 'Owner',
      canManage: true,
      createdBy: 'nonmember',
    });
    const list = await request(app('nonmember')).get('/api/organizations').expect(200);
    expect(list.body).toEqual({ organizations: [response.body.organization] });
    const adminList = await request(app('server-admin')).get('/api/organizations').expect(200);
    expect(adminList.body.organizations).toHaveLength(2);
    expect(JSON.stringify(adminList.body)).not.toContain('Foreign Organization');
    expect(
      adminList.body.organizations.find((o: { id: string }) => o.id === organizationId),
    ).toMatchObject({ role: null, canManage: true });
    const event = broadcast.mock.calls[0][0];
    expect(delivered(event, 'nonmember')).toBe(true);
    expect(delivered(event, 'member')).toBe(false);
  });

  it('validates names, member roles, and selectors with no mutations', async () => {
    for (const body of [
      {},
      { name: '' },
      { name: '   ' },
      { name: 12 },
      { name: 'x'.repeat(201) },
      { name: 'name', serverId: 'other' },
    ]) {
      await request(app('creator')).post('/api/organizations').send(body).expect(400);
      await request(app('creator')).patch(url()).send(body).expect(400);
    }
    for (const body of [
      {},
      { role: 'User' },
      { role: 'CEO' },
      { role: 'Admin', userId: 'outsider' },
    ]) {
      await request(app('creator')).put(`${url()}/members/member`).send(body).expect(400);
    }
    await request(app('creator')).get('/api/organizations?serverId=other').expect(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('protects the last Owner and supports an explicit ownership transfer', async () => {
    const client = request(app('server-admin'));
    await client.delete(`${url()}/members/creator`).expect(409);
    await client.put(`${url()}/members/creator`).send({ role: 'Admin' }).expect(409);
    expect(broadcast).not.toHaveBeenCalled();
    await client.put(`${url()}/members/member`).send({ role: 'Owner' }).expect(200);
    await client.put(`${url()}/members/creator`).send({ role: 'Member' }).expect(200);
    await client.delete(`${url()}/members/member`).expect(409);
    const members = await client.get(`${url()}/members`).expect(200);
    expect(
      members.body.members.every((m: unknown) => OrganizationMember.safeParse(m).success),
    ).toBe(true);
  });

  it('does not grant organization management through a stale Server role or spoofed bypass', async () => {
    const client = request(
      app('server-admin', 'default', { authRole: 'Owner', authViaApiKey: true }),
    );
    setMembershipRole('server-admin', 'default', 'User');
    await client.get(url()).expect(404);
    await client.patch(url()).send({ name: 'No' }).expect(404);
    setBusinessOrganizationMember('default', organizationId, 'server-admin', 'Member');
    await client.patch(url()).send({ name: 'No' }).expect(403);
    deleteMembership('server-admin', 'default');
    await client.get('/api/organizations').expect(404);
  });

  it('masks unknown, foreign and inaccessible IDs identically', async () => {
    const unknown = await request(app('nonmember')).get('/api/organizations/missing').expect(404);
    const hidden = await request(app('nonmember')).get(url()).expect(404);
    const foreign = await request(app('creator'))
      .get(`/api/organizations/${foreignId}`)
      .expect(404);
    expect(hidden.body).toEqual(unknown.body);
    expect(foreign.body).toEqual(unknown.body);
    for (const id of ['foreign-user', 'outsider', 'missing']) {
      await request(app('creator'))
        .put(`${url()}/members/${id}`)
        .send({ role: 'Member' })
        .expect(404);
      await request(app('creator')).delete(`${url()}/members/${id}`).expect(404);
    }
    await request(app('creator', 'remote')).get('/api/organizations').expect(404);
  });
});

describe('project access is an intersection, never a membership grant', () => {
  it.each(['member', 'org-admin', 'server-admin', 'server-owner'])(
    'filters links for %s without private metadata or counts',
    async (userId) => {
      const response = await request(app(userId)).get(`${url()}/projects`).expect(200);
      const ids = response.body.projects.map((p: { id: string }) => p.id);
      expect(ids).toEqual(userId === 'server-owner' ? ['restricted', 'shared'] : ['shared']);
      expect(
        response.body.projects.every((p: unknown) => OrganizationProject.safeParse(p).success),
      ).toBe(true);
      expect(Object.keys(response.body)).toEqual(['projects']);
      expect(JSON.stringify(response.body)).not.toMatch(/private|cwd|agents|total/);
    },
  );

  it.each(['org-admin', 'server-admin', 'server-owner'])(
    '%s cannot attach or detach private projects without read access',
    async (userId) => {
      for (const id of [
        'private',
        'hidden',
        'internal',
        '__hub__',
        'system',
        'foreign',
        'missing',
      ]) {
        const add = await request(app(userId)).put(`${url()}/projects/${id}`).expect(404);
        const remove = await request(app(userId)).delete(`${url()}/projects/${id}`).expect(404);
        expect(add.body).toEqual({ error: 'Project not found' });
        expect(remove.body).toEqual(add.body);
      }
      expect(broadcast).not.toHaveBeenCalled();
    },
  );

  it('rechecks assignment loss for reads, writes and WebSocket delivery', async () => {
    addProjectMember('private', 'org-admin', 'creator');
    const client = request(app('org-admin'));
    expect(
      (await client.get(`${url()}/projects`)).body.projects.map((p: { id: string }) => p.id),
    ).toEqual(['private', 'shared']);
    const event = {
      type: 'organization_invalidated',
      serverId: 'default',
      organizationId,
      action: 'project_detached',
      projectId: 'private',
    };
    expect(delivered(event, 'org-admin')).toBe(true);
    expect(delivered(event, 'server-owner')).toBe(false);
    removeProjectMember('private', 'org-admin');
    expect(
      (await client.get(`${url()}/projects`)).body.projects.map((p: { id: string }) => p.id),
    ).toEqual(['shared']);
    await client.delete(`${url()}/projects/private`).expect(404);
    expect(delivered(event, 'org-admin')).toBe(false);
    expect(delivered({ ...event, projectId: 'restricted' }, 'org-admin')).toBe(false);
  });

  it('links/unlinks idempotently without modifying ACLs, projects or other groups', async () => {
    const other = createBusinessOrganization({
      serverId: 'default',
      name: 'Second',
      createdBy: 'creator',
    });
    const acl = getOrgsDb().prepare('SELECT * FROM project_members').all();
    const projects = structuredClone(getProjects());
    const client = request(app('creator'));
    await client.put(`${url()}/projects/independent`).expect(200);
    await client.put(`${url()}/projects/independent`).expect(200);
    await client.put(`/api/organizations/${other.id}/projects/independent`).expect(200);
    await client.delete(`${url()}/projects/independent`).expect(200);
    await client.delete(`${url()}/projects/independent`).expect(200);
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast.mock.calls[2][0]).toMatchObject({
      type: 'organization_invalidated',
      action: 'project_detached',
      serverId: 'default',
      organizationId,
      projectId: 'independent',
    });
    expect(listBusinessOrganizationProjectIds('default', other.id)).toEqual(['independent']);
    expect(getProjects()).toEqual(projects);
    expect(getOrgsDb().prepare('SELECT * FROM project_members').all()).toEqual(acl);
    const member = await request(app('member')).get(`${url()}/projects`).expect(200);
    expect(member.body.projects.map((p: { id: string }) => p.id)).toEqual(['shared']);
  });

  it('reads and writes the authenticated Server registry without a global switch', async () => {
    const client = request(app('creator', 'other'));
    await client.put(`/api/organizations/${foreignId}/projects/shared`).expect(200);
    const response = await client.get(`/api/organizations/${foreignId}/projects`).expect(200);
    expect(response.body).toEqual({
      projects: [{ id: 'shared', name: 'Other Server shared project', visibility: 'shared' }],
    });
    await client.get(url()).expect(404);
    expect(getActiveOrgId()).toBe('default');
    expect(listBusinessOrganizationProjectIds('default', organizationId)).toEqual([
      'private',
      'restricted',
      'shared',
    ]);
    const event = broadcast.mock.calls[0][0];
    expect(delivered(event, 'creator', 'other')).toBe(true);
    expect(delivered(event, 'creator', 'default')).toBe(false);
    expect(delivered(event, 'member', 'other')).toBe(false);
  });

  it('does not reuse an ambiguous legacy project assignment across Servers with the same project ID', async () => {
    createMembership('org-admin', 'other', 'User');
    setBusinessOrganizationMember('other', foreignId, 'org-admin', 'Admin');
    writeFileSync(
      path.join(orgDataDir('other'), 'projects.json'),
      JSON.stringify([
        project('private', {
          name: 'Secret on another Server',
          visibility: 'private',
          ownerUserId: 'foreign-user',
        }),
      ]),
    );
    attachBusinessOrganizationProject('other', foreignId, 'private');
    // Legacy project_members has no Server key. An assignment cannot prove
    // access to either of two distinct projects sharing that ID.
    addProjectMember('private', 'org-admin', 'creator');
    const client = request(app('org-admin', 'other'));
    expect((await client.get(`/api/organizations/${foreignId}/projects`).expect(200)).body).toEqual(
      { projects: [] },
    );
    await client.delete(`/api/organizations/${foreignId}/projects/private`).expect(404);
    expect(
      delivered(
        {
          type: 'organization_invalidated',
          serverId: 'other',
          organizationId: foreignId,
          projectId: 'private',
        },
        'org-admin',
        'other',
      ),
    ).toBe(false);
    // Explicit project ownership remains unambiguous even with a duplicate ID.
    setBusinessOrganizationMember('other', foreignId, 'foreign-user', 'Member');
    expect(
      (
        await request(app('foreign-user', 'other'))
          .get(`/api/organizations/${foreignId}/projects`)
          .expect(200)
      ).body.projects,
    ).toHaveLength(1);
  });

  it('fails closed when the selected registry cannot be read', async () => {
    attachBusinessOrganizationProject('other', foreignId, 'foreign');
    writeFileSync(path.join(orgDataDir('other'), 'projects.json'), 'corrupt');
    await request(app('creator', 'other'))
      .get(`/api/organizations/${foreignId}/projects`)
      .expect(500);
    expect(
      delivered(
        {
          type: 'organization_invalidated',
          serverId: 'other',
          organizationId: foreignId,
          projectId: 'foreign',
        },
        'creator',
        'other',
      ),
    ).toBe(false);
  });
});

describe('organization invalidation and revocation', () => {
  it('removes membership idempotently and stops subsequent reads/events on the same connection', async () => {
    const client = request(app('creator'));
    const update = {
      type: 'organization_updated',
      serverId: 'default',
      organizationId,
      action: 'renamed',
    };
    expect(delivered(update, 'member')).toBe(true);
    await client.delete(`${url()}/members/member`).expect(200);
    await client.delete(`${url()}/members/member`).expect(200);
    expect(broadcast).toHaveBeenCalledTimes(2);
    const revoked = broadcast.mock.calls[0][0];
    expect(revoked).toEqual({
      type: 'organization_access_revoked',
      serverId: 'default',
      organizationId,
      userId: 'member',
      reason: 'member_removed',
    });
    expect(delivered(revoked, 'member')).toBe(true);
    expect(delivered(revoked, 'creator')).toBe(false);
    expect(delivered({ ...revoked, name: 'Secret metadata' }, 'member')).toBe(false);
    expect(delivered(update, 'member')).toBe(false);
    await request(app('member')).get(url()).expect(404);
    expect((await request(app('member')).get('/api/organizations')).body).toEqual({
      organizations: [],
    });
    deleteMembership('member', 'default');
    expect(delivered(revoked, 'member')).toBe(false);
  });

  it('archives with explicit per-user invalidations while preserving projects and other groups', async () => {
    const second = createBusinessOrganization({
      serverId: 'default',
      name: 'Second',
      createdBy: 'creator',
    });
    attachBusinessOrganizationProject('default', second.id, 'shared');
    const projects = structuredClone(getProjects());
    await request(app('org-admin')).delete(url()).expect(200);
    expect(getBusinessOrganization('default', organizationId)).toBeNull();
    expect(
      getBusinessOrganization('default', organizationId, { includeArchived: true })?.archived_at,
    ).toBeTruthy();
    expect(listBusinessOrganizationMembers('default', organizationId)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', organizationId)).toEqual([]);
    expect(listBusinessOrganizationProjectIds('default', second.id)).toEqual(['shared']);
    expect(getProjects()).toEqual(projects);
    expect(broadcast).toHaveBeenCalledTimes(5);
    for (const [event] of broadcast.mock.calls) {
      expect(event).toMatchObject({
        type: 'organization_access_revoked',
        serverId: 'default',
        organizationId,
        reason: 'archived',
      });
      expect(delivered(event, event.userId)).toBe(true);
      expect(delivered(event, 'nonmember')).toBe(false);
      expect(delivered(event, event.userId, 'other')).toBe(false);
    }
    expect(
      delivered(
        { type: 'organization_updated', serverId: 'default', organizationId },
        'server-admin',
      ),
    ).toBe(false);
    await request(app('server-admin')).get(url()).expect(404);
    await request(app('creator')).put(`${url()}/projects/shared`).expect(404);
  });

  it('rechecks current Server admin role and organization membership for every event', () => {
    const event = { type: 'organization_updated', serverId: 'default', organizationId };
    expect(delivered(event, 'server-admin')).toBe(true);
    expect(delivered(event, 'nonmember')).toBe(false);
    setMembershipRole('server-admin', 'default', 'User');
    expect(delivered(event, 'server-admin')).toBe(false);
    deleteMembership('creator', 'default');
    expect(delivered(event, 'creator')).toBe(false);
  });
});

describe('organization project choices', () => {
  it('requires a user identity and rejects foreign selectors', async () => {
    await request(app(undefined, 'default', { authViaApiKey: true }))
      .get('/api/organizations/project-choices')
      .expect(401);
    await request(app('outsider')).get('/api/organizations/project-choices').expect(404);
    await request(app('creator'))
      .get('/api/organizations/project-choices?serverId=other')
      .expect(400);
  });

  it('lists only attachable summaries for the acting user, including before creating any organization', async () => {
    const result = await request(app('nonmember'))
      .get('/api/organizations/project-choices')
      .expect(200);
    expect(result.body.projects).toEqual([
      { id: 'shared', name: 'shared', visibility: 'shared' },
      { id: 'independent', name: 'independent', visibility: 'shared' },
    ]);
  });
  it('reads the authenticated Server registry without switching the active Server', async () => {
    const before = getActiveOrgId();
    const result = await request(app('foreign-user', 'other'))
      .get('/api/organizations/project-choices')
      .expect(200);
    expect(result.body.projects.map((p: { id: string }) => p.id)).toEqual(['foreign', 'shared']);
    expect(result.body.projects[1].name).toBe('Other Server shared project');
    expect(getActiveOrgId()).toBe(before);
  });
  it('does not give Server administrators a private-project read bypass', async () => {
    const result = await request(app('server-owner'))
      .get('/api/organizations/project-choices')
      .expect(200);
    expect(result.body.projects.map((p: { id: string }) => p.id)).not.toContain('private');
  });
});
