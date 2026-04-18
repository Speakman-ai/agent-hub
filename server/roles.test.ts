import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import supertest from 'supertest';
import { ROLES, coerceRoleOrOwner, hasAtLeastRole, parseRole, requireRole } from './roles.js';
import type { AuthenticatedRequest } from './auth.js';

describe('roles — hierarchy helpers', () => {
  it('exposes Owner/Admin/User in descending priority', () => {
    expect(ROLES).toEqual(['Owner', 'Admin', 'User']);
  });

  it('parseRole accepts only exact matches', () => {
    expect(parseRole('Owner')).toBe('Owner');
    expect(parseRole('Admin')).toBe('Admin');
    expect(parseRole('User')).toBe('User');
    // Case-sensitive — lower-case is a common typo and should fail loudly.
    expect(parseRole('owner')).toBeNull();
    expect(parseRole('')).toBeNull();
    expect(parseRole(null)).toBeNull();
    expect(parseRole(undefined)).toBeNull();
    expect(parseRole(42)).toBeNull();
  });

  it('coerceRoleOrOwner backfills missing / invalid values to Owner', () => {
    // This is the migration path for pre-Phase-2 auth.json files that
    // have no `role` field. They must not be silently demoted.
    expect(coerceRoleOrOwner(undefined)).toBe('Owner');
    expect(coerceRoleOrOwner(null)).toBe('Owner');
    expect(coerceRoleOrOwner('garbage')).toBe('Owner');
    expect(coerceRoleOrOwner('Admin')).toBe('Admin');
    expect(coerceRoleOrOwner('User')).toBe('User');
  });

  describe('hasAtLeastRole', () => {
    it('Owner satisfies every requirement', () => {
      expect(hasAtLeastRole('Owner', 'Owner')).toBe(true);
      expect(hasAtLeastRole('Owner', 'Admin')).toBe(true);
      expect(hasAtLeastRole('Owner', 'User')).toBe(true);
    });
    it('Admin satisfies Admin and User but not Owner', () => {
      expect(hasAtLeastRole('Admin', 'Owner')).toBe(false);
      expect(hasAtLeastRole('Admin', 'Admin')).toBe(true);
      expect(hasAtLeastRole('Admin', 'User')).toBe(true);
    });
    it('User satisfies only User', () => {
      expect(hasAtLeastRole('User', 'Owner')).toBe(false);
      expect(hasAtLeastRole('User', 'Admin')).toBe(false);
      expect(hasAtLeastRole('User', 'User')).toBe(true);
    });
    it('missing role satisfies nothing', () => {
      expect(hasAtLeastRole(null, 'User')).toBe(false);
      expect(hasAtLeastRole(undefined, 'User')).toBe(false);
    });
  });
});

describe('requireRole middleware', () => {
  function buildApp(injectedRole?: string | null) {
    const app = express();
    // Stub middleware simulates what authMiddleware does in production:
    // attach `authRole` based on upstream auth. Setting null models the
    // unauthenticated case that somehow reaches the gate.
    app.use((req, _res, next) => {
      if (injectedRole !== null && injectedRole !== undefined) {
        (req as AuthenticatedRequest).authRole = injectedRole as AuthenticatedRequest['authRole'];
      }
      next();
    });
    app.get('/admin-only', requireRole('Admin'), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.get('/owner-only', requireRole('Owner'), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    app.get('/anyone', requireRole('User'), (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('401s when no role is attached to the request', async () => {
    const res = await supertest(buildApp(null)).get('/admin-only');
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/authentication required/i);
  });

  it('lets Owner through every gate', async () => {
    const app = buildApp('Owner');
    expect((await supertest(app).get('/admin-only')).status).toBe(200);
    expect((await supertest(app).get('/owner-only')).status).toBe(200);
    expect((await supertest(app).get('/anyone')).status).toBe(200);
  });

  it('lets Admin through Admin and User gates but not Owner', async () => {
    const app = buildApp('Admin');
    expect((await supertest(app).get('/admin-only')).status).toBe(200);
    expect((await supertest(app).get('/anyone')).status).toBe(200);
    const owner = await supertest(app).get('/owner-only');
    expect(owner.status).toBe(403);
    expect(owner.body).toMatchObject({
      requiredRole: 'Owner',
      currentRole: 'Admin',
    });
  });

  it('lets User through User gates but rejects Admin/Owner', async () => {
    const app = buildApp('User');
    expect((await supertest(app).get('/anyone')).status).toBe(200);
    const admin = await supertest(app).get('/admin-only');
    expect(admin.status).toBe(403);
    expect(admin.body.currentRole).toBe('User');
    const owner = await supertest(app).get('/owner-only');
    expect(owner.status).toBe(403);
  });
});
