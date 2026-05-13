import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createProjectVisibilityGate } from './project-visibility-middleware.js';
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
