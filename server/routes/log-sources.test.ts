/**
 * Log-source route tests. The happy paths run against the real Express app
 * (supertest) where the test harness authenticates as the break-glass Owner
 * (localBypass), so the Admin gate + project visibility both pass. The role
 * gate itself is exercised in isolation with a stubbed auth middleware, since
 * the shared app has no way to downgrade the caller to a plain User.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import express from 'express';
import stSupertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import createLogSourceRoutes from './log-sources.js';
import type { Project, RouteDeps } from '../types.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ cwd: '/tmp' });
  projectId = project.id as string;
});

const base = () => `/api/projects/${projectId}/log-sources`;

describe('log-source CRUD + token lifecycle (integration)', () => {
  it('creates a source and reveals the ahlog_ token exactly once', async () => {
    const res = await request
      .post(base())
      .send({ name: 'checkout-api', serviceName: 'checkout', environment: 'prod' })
      .expect(201);

    expect(res.body.token).toMatch(/^ahlog_[A-Za-z0-9_-]{40,}$/);
    expect(res.body.status).toBe('active');
    expect(res.body.tokenPrefix).toBe(String(res.body.token).slice(0, 14));

    // The token never resurfaces on a subsequent read.
    const one = await request.get(`${base()}/${res.body.id}`).expect(200);
    expect(one.body).not.toHaveProperty('token');
    expect(one.body.name).toBe('checkout-api');
  });

  it('lists sources without any token material', async () => {
    await request.post(base()).send({ name: 'lister-src' }).expect(201);
    const res = await request.get(base()).expect(200);
    expect(Array.isArray(res.body.sources)).toBe(true);
    for (const s of res.body.sources) {
      expect(s).not.toHaveProperty('token');
      expect(s).not.toHaveProperty('tokenHash');
    }
  });

  it('rotates the token, returning a fresh plaintext', async () => {
    const created = await request.post(base()).send({ name: 'rotate-src' }).expect(201);
    const rotated = await request.post(`${base()}/${created.body.id}/rotate`).expect(200);
    expect(rotated.body.token).toMatch(/^ahlog_/);
    expect(rotated.body.token).not.toBe(created.body.token);
    expect(rotated.body.status).toBe('active');
    expect(rotated.body.rotatedAt).toBeTypeOf('number');
  });

  it('revokes the token, flipping status to revoked', async () => {
    const created = await request.post(base()).send({ name: 'revoke-src' }).expect(201);
    const revoked = await request.post(`${base()}/${created.body.id}/revoke`).expect(200);
    expect(revoked.body.status).toBe('revoked');
    expect(revoked.body.revokedAt).toBeTypeOf('number');
  });

  it('updates metadata via PATCH without a token change', async () => {
    const created = await request.post(base()).send({ name: 'patch-src' }).expect(201);
    const patched = await request
      .patch(`${base()}/${created.body.id}`)
      .send({ name: 'patched', environment: 'staging' })
      .expect(200);
    expect(patched.body.name).toBe('patched');
    expect(patched.body.environment).toBe('staging');
    expect(patched.body.tokenPrefix).toBe(created.body.tokenPrefix);
  });

  it('deletes a source (204) then 404s on re-read', async () => {
    const created = await request.post(base()).send({ name: 'delete-src' }).expect(201);
    await request.delete(`${base()}/${created.body.id}`).expect(204);
    await request.get(`${base()}/${created.body.id}`).expect(404);
  });

  it('exposes the lifecycle audit trail', async () => {
    const created = await request.post(base()).send({ name: 'audit-src' }).expect(201);
    await request.post(`${base()}/${created.body.id}/rotate`).expect(200);
    await request.post(`${base()}/${created.body.id}/revoke`).expect(200);
    const audit = await request.get(`${base()}/${created.body.id}/audit`).expect(200);
    const actions = audit.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['create', 'rotate', 'revoke']));
  });

  it('409s on a duplicate source name in the same project', async () => {
    await request.post(base()).send({ name: 'unique-one' }).expect(201);
    await request.post(base()).send({ name: 'unique-one' }).expect(409);
  });

  it('400s on an invalid body', async () => {
    await request.post(base()).send({ name: '' }).expect(400);
    await request.post(base()).send({}).expect(400);
  });

  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist-xyz/log-sources').expect(404);
    await request
      .post('/api/projects/does-not-exist-xyz/log-sources')
      .send({ name: 'x' })
      .expect(404);
  });

  it('404s for an unknown source id under a real project', async () => {
    await request.get(`${base()}/ghost-source`).expect(404);
    await request.post(`${base()}/ghost-source/rotate`).expect(404);
    await request.post(`${base()}/ghost-source/revoke`).expect(404);
    await request.patch(`${base()}/ghost-source`).send({ name: 'x' }).expect(404);
    await request.delete(`${base()}/ghost-source`).expect(404);
  });
});

// ─── Role gate, isolated from the shared app's break-glass Owner ────────────
function buildStubbedApp(stub: { role?: string; userId?: string }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as unknown as { authRole?: string; authUserId?: string };
    if (stub.role !== undefined) r.authRole = stub.role;
    if (stub.userId !== undefined) r.authUserId = stub.userId;
    next();
  });
  const deps = {
    findProject: (id: string): Project | null =>
      id === 'p1' ? ({ id: 'p1', name: 'P1' } as unknown as Project) : null,
  } as unknown as RouteDeps;
  app.use(createLogSourceRoutes(deps));
  return app;
}

describe('log-source route authorization', () => {
  it('401s when the request carries no role', async () => {
    const app = buildStubbedApp({});
    await stSupertest(app).get('/api/projects/p1/log-sources').expect(401);
  });

  it('403s a plain User (management requires Admin)', async () => {
    const app = buildStubbedApp({ role: 'User', userId: 'u1' });
    await stSupertest(app).get('/api/projects/p1/log-sources').expect(403);
    await stSupertest(app).post('/api/projects/p1/log-sources').send({ name: 'x' }).expect(403);
    await stSupertest(app).post('/api/projects/p1/log-sources/s1/rotate').expect(403);
    await stSupertest(app).post('/api/projects/p1/log-sources/s1/revoke').expect(403);
    await stSupertest(app).delete('/api/projects/p1/log-sources/s1').expect(403);
  });
});
