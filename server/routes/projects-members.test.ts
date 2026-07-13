/**
 * Route-level tests for the Owner-managed per-project member ACL:
 *
 *   GET    /api/projects/:projectId/members
 *   POST   /api/projects/:projectId/members
 *   DELETE /api/projects/:projectId/members/:userId
 *
 * These endpoints gate who can see a project (see project-visibility.ts).
 * Only org Owners (or the local-bundle / global-apiKey break-glass) may
 * mutate the ACL. We mount the real projects router into a tiny Express app
 * and stamp auth claims per request, mocking the orgs.db-backed stores so
 * the test needs no real database — same pattern as
 * projects-analyze-spawn-env.test.ts and agents-visibility.test.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Project } from '../types.js';

vi.mock('../project-members-store.js', () => ({
  addProjectMember: vi.fn(),
  isProjectMember: vi.fn(() => false),
  isProjectRestricted: vi.fn(() => false),
  removeAllProjectMembers: vi.fn(() => 0),
  removeProjectMember: vi.fn(() => true),
  listProjectMembers: vi.fn(() => []),
  // Consumed by the real resolveVisibilityCaller — return empty ACL so the
  // caller's role alone decides management access.
  assignedProjectIdsForUser: vi.fn(() => new Set<string>()),
  restrictedProjectIds: vi.fn(() => new Set<string>()),
}));

vi.mock('../users-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../users-store.js')>();
  return {
    ...actual,
    getUserById: vi.fn((id: string) => (id === 'bob' ? { id: 'bob', username: 'bob' } : null)),
  };
});

vi.mock('../memberships-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../memberships-store.js')>();
  return {
    ...actual,
    // bob is an org member; anyone else is not.
    getMembershipRole: vi.fn((userId: string) => (userId === 'bob' ? 'User' : null)),
  };
});

vi.mock('../orgs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../orgs.js')>();
  return { ...actual, getActiveOrgId: vi.fn(() => 'default') };
});

const membersStore = await import('../project-members-store.js');
const { default: createProjectRoutes } = await import('./projects.js');

interface Claims {
  authUserId?: string;
  authRole?: 'Owner' | 'Admin' | 'User';
  authViaApiKey?: boolean;
  authLocalOrgBypass?: boolean;
}

function buildApp(claims: Claims, initialProjects?: Project[], saveProjects = vi.fn()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const areq = req as unknown as Record<string, unknown>;
    if (claims.authUserId !== undefined) areq.authUserId = claims.authUserId;
    if (claims.authRole !== undefined) areq.authRole = claims.authRole;
    if (claims.authViaApiKey !== undefined) areq.authViaApiKey = claims.authViaApiKey;
    if (claims.authLocalOrgBypass !== undefined) {
      areq.authLocalOrgBypass = claims.authLocalOrgBypass;
    }
    // A real authUser record keeps `noAuthConfigured` false so the caller
    // is NOT collapsed into localBypass — we want the real role gate.
    if (claims.authUserId !== undefined) {
      areq.authUser = { id: claims.authUserId, username: claims.authUserId };
    }
    next();
  });
  const project: Project = {
    id: 'proj-1',
    name: 'Proj 1',
    cwd: '/tmp',
    ahw: '/tmp/ahw',
    visibility: 'shared',
    ownerUserId: 'creator',
    agents: [],
  };
  const projects = initialProjects ?? [project];
  const dataRoot = mkdtempSync(path.join(tmpdir(), 'agent-hub-project-route-'));
  const deps = {
    broadcast: vi.fn(),
    findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
    getProjects: () => projects,
    saveProjects,
    config: { defaultCwd: '/tmp', dataDir: dataRoot, projectsDir: '/tmp' },
    getProjectDataDir: (id: string) => path.join(dataRoot, id),
  };
  app.use(createProjectRoutes(deps as unknown as Parameters<typeof createProjectRoutes>[0]));
  return app;
}

describe('project member ACL routes', () => {
  beforeEach(() => vi.clearAllMocks());

  describe('POST /api/projects/:projectId/members', () => {
    it('403 for a non-Owner caller', async () => {
      const res = await supertest(buildApp({ authUserId: 'ada', authRole: 'User' }))
        .post('/api/projects/proj-1/members')
        .send({ userId: 'bob' });
      expect(res.status).toBe(403);
      expect(membersStore.addProjectMember).not.toHaveBeenCalled();
    });

    it('201 and assigns when an Owner adds an org user', async () => {
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/proj-1/members')
        .send({ userId: 'bob' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ projectId: 'proj-1', userId: 'bob', username: 'bob' });
      expect(membersStore.addProjectMember).toHaveBeenCalledWith('proj-1', 'bob', 'boss');
    });

    it('200 and remains idempotent when an Owner re-adds an existing member', async () => {
      (membersStore.isProjectMember as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      );
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/proj-1/members')
        .send({ userId: 'bob' });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ projectId: 'proj-1', userId: 'bob', username: 'bob' });
      expect(membersStore.addProjectMember).toHaveBeenCalledWith('proj-1', 'bob', 'boss');
    });

    it('400 when userId is missing', async () => {
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/proj-1/members')
        .send({});
      expect(res.status).toBe(400);
    });

    it('404 when the user does not exist', async () => {
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/proj-1/members')
        .send({ userId: 'ghost' });
      expect(res.status).toBe(404);
    });

    it('400 when the user is not a member of the org', async () => {
      // 'bob' exists (getUserById) but simulate a cross-org id by forcing
      // getMembershipRole to null for this one call.
      const memberships = await import('../memberships-store.js');
      (memberships.getMembershipRole as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        null,
      );
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/proj-1/members')
        .send({ userId: 'bob' });
      expect(res.status).toBe(400);
      expect(membersStore.addProjectMember).not.toHaveBeenCalled();
    });

    it('404 when the project does not exist', async () => {
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' }))
        .post('/api/projects/nope/members')
        .send({ userId: 'bob' });
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/projects — creator ACL seeding', () => {
    it('seeds the authenticated creator as a member and reports the project as restricted', async () => {
      const app = buildApp({ authUserId: 'boss', authRole: 'Owner' }, []);
      const res = await supertest(app)
        .post('/api/projects')
        .send({ id: 'created-1', name: 'Created 1', cwd: '/tmp' });

      expect(res.status).toBe(201);
      expect(res.body.ownerUserId).toBe('boss');
      expect(membersStore.addProjectMember).toHaveBeenCalledWith('created-1', 'boss', 'boss');

      (membersStore.listProjectMembers as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { userId: 'boss', username: 'boss', addedBy: 'boss', createdAt: '1' },
      ]);
      (membersStore.isProjectRestricted as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      );
      const members = await supertest(app).get('/api/projects/created-1/members');
      expect(members.status).toBe(200);
      expect(members.body).toMatchObject({
        projectId: 'created-1',
        ownerUserId: 'boss',
        visibility: 'shared',
        restricted: true,
        members: [{ userId: 'boss', username: 'boss' }],
      });
    });

    it('skips creator seeding for break-glass callers that have no user id', async () => {
      const app = buildApp({ authRole: 'Owner', authViaApiKey: true }, []);
      const res = await supertest(app)
        .post('/api/projects')
        .send({ id: 'created-api-key', name: 'API Key Created', cwd: '/tmp' });

      expect(res.status).toBe(201);
      expect(res.body.ownerUserId).toBeNull();
      expect(membersStore.addProjectMember).not.toHaveBeenCalled();
    });

    it('succeeds with a private project when creator ACL seeding fails', async () => {
      const app = buildApp({ authUserId: 'boss', authRole: 'Owner' }, []);
      (membersStore.addProjectMember as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
        () => {
          throw new Error('orgs.db unavailable');
        },
      );
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await supertest(app)
          .post('/api/projects')
          .send({ id: 'created-fail', name: 'Created Fail', cwd: '/tmp' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          id: 'created-fail',
          ownerUserId: 'boss',
          visibility: 'private',
        });
        expect(membersStore.addProjectMember).toHaveBeenCalledWith('created-fail', 'boss', 'boss');

        const project = await supertest(app).get('/api/projects/created-fail');
        expect(project.status).toBe(200);
        expect(project.body).toMatchObject({
          id: 'created-fail',
          ownerUserId: 'boss',
          visibility: 'private',
        });
      } finally {
        consoleErr.mockRestore();
      }
    });

    it('keeps the project private when publishing shared visibility fails after ACL seeding', async () => {
      const saveProjects = vi
        .fn()
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => {
          throw new Error('disk unavailable');
        });
      const app = buildApp({ authUserId: 'boss', authRole: 'Owner' }, [], saveProjects);
      const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const res = await supertest(app)
          .post('/api/projects')
          .send({ id: 'created-publish-fail', name: 'Created Publish Fail', cwd: '/tmp' });

        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ error: 'project_visibility_publish_failed' });
        expect(saveProjects).toHaveBeenCalledTimes(2);
        expect(membersStore.addProjectMember).toHaveBeenCalledWith(
          'created-publish-fail',
          'boss',
          'boss',
        );

        const project = await supertest(app).get('/api/projects/created-publish-fail');
        expect(project.status).toBe(200);
        expect(project.body).toMatchObject({
          id: 'created-publish-fail',
          ownerUserId: 'boss',
          visibility: 'private',
        });
      } finally {
        consoleErr.mockRestore();
      }
    });
  });

  describe('DELETE /api/projects/:projectId/members/:userId', () => {
    it('403 for a non-Owner caller', async () => {
      const res = await supertest(buildApp({ authUserId: 'ada', authRole: 'User' })).delete(
        '/api/projects/proj-1/members/bob',
      );
      expect(res.status).toBe(403);
      expect(membersStore.removeProjectMember).not.toHaveBeenCalled();
    });

    it('200 and removes when an Owner unassigns a member', async () => {
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' })).delete(
        '/api/projects/proj-1/members/bob',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ projectId: 'proj-1', userId: 'bob', removed: true });
      expect(membersStore.removeProjectMember).toHaveBeenCalledWith('proj-1', 'bob');
    });

    it('404 when the user was not a member', async () => {
      (membersStore.removeProjectMember as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        false,
      );
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' })).delete(
        '/api/projects/proj-1/members/bob',
      );
      expect(res.status).toBe(404);
    });
  });

  describe('GET /api/projects/:projectId/members', () => {
    it('403 for a non-Owner caller', async () => {
      const res = await supertest(buildApp({ authUserId: 'ada', authRole: 'User' })).get(
        '/api/projects/proj-1/members',
      );
      expect(res.status).toBe(403);
    });

    it('returns the ACL (restricted flag reflects restriction marker) for an Owner', async () => {
      (membersStore.listProjectMembers as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce([
        { userId: 'bob', username: 'bob', addedBy: 'boss', createdAt: '1' },
      ]);
      (membersStore.isProjectRestricted as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      );
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' })).get(
        '/api/projects/proj-1/members',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        projectId: 'proj-1',
        ownerUserId: 'creator',
        visibility: 'shared',
        restricted: true,
        members: [{ userId: 'bob', username: 'bob' }],
      });
    });

    it('can report restricted=true even when no users are currently assigned', async () => {
      (membersStore.isProjectRestricted as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        true,
      );
      const res = await supertest(buildApp({ authUserId: 'boss', authRole: 'Owner' })).get(
        '/api/projects/proj-1/members',
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        projectId: 'proj-1',
        visibility: 'shared',
        restricted: true,
        members: [],
      });
    });
  });
});
