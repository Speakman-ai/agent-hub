import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const aclStore = vi.hoisted(() => ({
  assignedProjectIdsForUser: vi.fn(() => new Set<string>()),
  restrictedProjectIds: vi.fn(() => new Set<string>()),
}));

vi.mock('./project-members-store.js', () => aclStore);

import {
  createProjectVisibilityGate,
  resolveVisibilityCaller,
} from './project-visibility-middleware.js';
import type { Project } from './types.js';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Test Project',
    cwd: '/tmp/p1',
    ahw: '/tmp/p1-ahw',
    agents: [],
    ...overrides,
  };
}

/**
 * Build a minimal Express-like request with AuthenticatedRequest fields.
 * The middleware casts req to AuthenticatedRequest internally, so we just
 * spread the fields onto a plain object.
 */
function makeReq(overrides: Record<string, unknown> = {}): Request {
  return {
    params: { projectId: 'p1' },
    method: 'GET',
    baseUrl: '/api/projects/p1',
    path: '/',
    originalUrl: '/api/projects/p1',
    ...overrides,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

/**
 * These tests exercise the non-bypass branches of createProjectVisibilityGate.
 *
 * The integration suite in project-visibility.test.ts runs under a
 * no-auth-configured environment (no AGENT_HUB_API_KEY, no auth.json), which
 * causes localBypass=true and makes the gate a no-op. The unit tests here
 * use real authUserId values so that noAuthConfigured resolves to false.
 */
describe('createProjectVisibilityGate — non-bypass branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aclStore.assignedProjectIdsForUser.mockReturnValue(new Set<string>());
    aclStore.restrictedProjectIds.mockReturnValue(new Set<string>());
  });

  const privateProject = makeProject({ id: 'p1', visibility: 'private', ownerUserId: 'owner-123' });
  const gate = createProjectVisibilityGate({ findProject: () => privateProject });

  it('authenticated User GETs a private project they do not own → 404', () => {
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'GET',
      originalUrl: '/api/projects/p1',
      // Real authUserId keeps noAuthConfigured = false → no bypass
      authUserId: 'other-user',
      authUser: 'other-user-name',
      authRole: 'User',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });

  it('authenticated User DELETEs a private project they do not own → next() (route handler decides)', () => {
    // The gate lets DELETE /api/projects/:projectId fall through so the route
    // handler's canDeleteProject kill-switch can run. The same fall-through
    // applies to non-owners; the handler is then responsible for the final deny.
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'DELETE',
      baseUrl: '/api/projects/p1',
      path: '/',
      originalUrl: '/api/projects/p1',
      authUserId: 'other-user',
      authUser: 'other-user-name',
      authRole: 'User',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('org Owner GETs a private project they do not own → 404 (no view bypass for Owners)', () => {
    // Owners can list-and-delete via the admin endpoint but cannot read contents.
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'GET',
      originalUrl: '/api/projects/p1',
      authUserId: 'org-owner-id',
      authUser: 'org-owner',
      authRole: 'Owner',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });

  it('org Owner DELETEs a private project they do not own → next() (Owner kill-switch falls through)', () => {
    // canViewProject is false for Owners on others' private projects, but
    // the isDeleteSelf exception lets the DELETE fall through so the route
    // handler's canDeleteProject Owner kill-switch can grant the deletion.
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'DELETE',
      baseUrl: '/api/projects/p1',
      path: '/',
      originalUrl: '/api/projects/p1',
      authUserId: 'org-owner-id',
      authUser: 'org-owner',
      authRole: 'Owner',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('org Owner GETs private project members they do not own → next() (ACL admin route decides)', () => {
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'GET',
      baseUrl: '/api/projects/p1',
      path: '/members',
      originalUrl: '/api/projects/p1/members',
      authUserId: 'org-owner-id',
      authUser: 'org-owner',
      authRole: 'Owner',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('non-Owner GETs private project members they do not own → 404', () => {
    const req = makeReq({
      params: { projectId: 'p1' },
      method: 'GET',
      baseUrl: '/api/projects/p1',
      path: '/members',
      originalUrl: '/api/projects/p1/members',
      authUserId: 'other-user',
      authUser: 'other-user-name',
      authRole: 'User',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    gate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });

  it('shared project: any caller passes through', () => {
    const sharedGate = createProjectVisibilityGate({
      findProject: () => makeProject({ id: 'p1', visibility: 'shared' }),
    });
    const req = makeReq({
      authUserId: 'some-user',
      authUser: 'some-user-name',
      authRole: 'User',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    sharedGate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('shared project: non-Owner fails closed when the assignment ACL cannot be loaded', () => {
    aclStore.restrictedProjectIds.mockImplementationOnce(() => {
      throw new Error('orgs.db unavailable');
    });
    const sharedGate = createProjectVisibilityGate({
      findProject: () => makeProject({ id: 'p1', visibility: 'shared' }),
    });
    const req = makeReq({
      authUserId: 'some-user',
      authUser: 'some-user-name',
      authRole: 'User',
    });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    sharedGate(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
  });

  it('missing project: gate passes through (downstream route owns 404)', () => {
    const missingGate = createProjectVisibilityGate({ findProject: () => null });
    const req = makeReq({ authUserId: 'u1', authUser: 'u1', authRole: 'User' });
    const res = makeRes();
    const next = vi.fn() as unknown as NextFunction;

    missingGate(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('resolveVisibilityCaller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    aclStore.assignedProjectIdsForUser.mockReturnValue(new Set<string>());
    aclStore.restrictedProjectIds.mockReturnValue(new Set<string>());
  });

  it('authenticated User → userId set, role copied, no bypass', () => {
    const caller = resolveVisibilityCaller(
      makeReq({ authUserId: 'u-123', authUser: 'ada', authRole: 'User' }),
    );
    expect(caller).toMatchObject({
      userId: 'u-123',
      role: 'User',
      localBypass: false,
      assignmentAclUnavailable: false,
    });
    expect(caller.assignedProjectIds).toEqual(new Set<string>());
    expect(caller.restrictedProjectIds).toEqual(new Set<string>());
  });

  it('authenticated Owner → userId set, role=Owner, no bypass', () => {
    // An org Owner with a real `authUserId` does NOT get a localBypass —
    // privacy still applies to them via `canViewProject` (Owners do not
    // get a read bypass on others' private projects).
    const caller = resolveVisibilityCaller(
      makeReq({ authUserId: 'owner-1', authUser: 'owner-1', authRole: 'Owner' }),
    );
    expect(caller).toMatchObject({
      userId: 'owner-1',
      role: 'Owner',
      localBypass: false,
      assignmentAclUnavailable: false,
    });
  });

  it('authenticated User → marks ACL unavailable when the store throws', () => {
    aclStore.restrictedProjectIds.mockImplementationOnce(() => {
      throw new Error('orgs.db unavailable');
    });
    const caller = resolveVisibilityCaller(
      makeReq({ authUserId: 'u-123', authUser: 'ada', authRole: 'User' }),
    );
    expect(caller.assignmentAclUnavailable).toBe(true);
    expect(caller.assignedProjectIds).toEqual(new Set<string>());
    expect(caller.restrictedProjectIds).toEqual(new Set<string>());
  });

  it('local-bundled bypass → bypass=true even with no userId', () => {
    const caller = resolveVisibilityCaller(
      makeReq({ authRole: 'Owner', authLocalOrgBypass: true }),
    );
    expect(caller.localBypass).toBe(true);
  });

  it('global x-api-key break-glass → bypass=true', () => {
    const caller = resolveVisibilityCaller(makeReq({ authRole: 'Owner', authViaApiKey: true }));
    expect(caller.localBypass).toBe(true);
  });

  it('no-auth-configured (Owner role + no user id + no user record) → bypass=true', () => {
    // Matches the auth middleware's fresh-install / dev / unit-test
    // early-return branch: `authRole='Owner'` is stamped but no
    // `authUserId` or `authUser` is attached.
    const caller = resolveVisibilityCaller(makeReq({ authRole: 'Owner' }));
    expect(caller.localBypass).toBe(true);
    expect(caller.userId).toBeNull();
  });

  it('no claims at all → userId null, no bypass (real multi-user deployment, anonymous caller)', () => {
    // The middleware upstream would normally 401 before we get here; this
    // test pins the helper's behavior so callers that reach it without
    // any claims fall closed (no bypass, no userId → private projects
    // hidden).
    const caller = resolveVisibilityCaller(makeReq({}));
    expect(caller.userId).toBeNull();
    expect(caller.localBypass).toBe(false);
    expect(caller.assignmentAclUnavailable).toBe(false);
  });
});
