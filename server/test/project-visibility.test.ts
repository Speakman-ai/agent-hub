/**
 * Integration tests for the project visibility feature.
 *
 * The test environment runs under "no auth configured" (see
 * `server/test/setup.ts` — `AGENT_HUB_API_KEY` is deleted, and no
 * `auth.json` is written). Under that mode the auth middleware stamps
 * `authRole='Owner'` with no `authUserId`, which the visibility
 * resolver collapses into a localBypass — i.e. every caller sees every
 * project, mirroring single-tenant dev.
 *
 * The interesting test cases here exercise:
 *   - `POST /api/projects` defaults visibility to 'shared'
 *   - `POST /api/projects` accepts an explicit 'private' visibility and
 *     persists it (with null owner, since the test caller has no JWT)
 *   - `GET /api/admin/projects` returns the admin row shape (id, name,
 *     visibility, ownerUserId, ownerUsername, canEnter, agentCount)
 *   - `POST /api/projects` rejects an invalid visibility value
 *
 * The cross-user visibility scenarios (User A creates private project,
 * User B 404s on it, Owner can DELETE it) are covered as a unit test
 * against the helpers (`server/project-visibility.test.ts`) — wiring a
 * full multi-user JWT context through supertest here would duplicate
 * the auth integration tests without adding signal over the helper
 * tests.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('POST /api/projects — visibility', () => {
  it('defaults visibility to "shared" when omitted', async () => {
    const id = `vis-default-${Date.now()}`;
    const res = await request
      .post('/api/projects')
      .send({ id, name: 'Default', cwd: '/tmp' })
      .expect(201);
    expect(res.body.visibility).toBe('shared');
    expect(res.body.ownerUserId).toBeNull();
  });

  it('accepts an explicit visibility=shared', async () => {
    const id = `vis-shared-${Date.now()}`;
    const res = await request
      .post('/api/projects')
      .send({ id, name: 'Shared', cwd: '/tmp', visibility: 'shared' })
      .expect(201);
    expect(res.body.visibility).toBe('shared');
  });

  it('accepts an explicit visibility=private (null owner allowed under bypass)', async () => {
    // Test env runs under no-auth-configured bypass; a null-owner private
    // project is still reachable to bypass callers. Production deployments
    // with real auth get the explicit "authenticated user required" guard.
    const id = `vis-private-${Date.now()}`;
    const res = await request
      .post('/api/projects')
      .send({ id, name: 'Private', cwd: '/tmp', visibility: 'private' })
      .expect(201);
    expect(res.body.visibility).toBe('private');
  });

  it('rejects visibility values other than shared/private', async () => {
    await request
      .post('/api/projects')
      .send({ id: `vis-bad-${Date.now()}`, name: 'Bad', cwd: '/tmp', visibility: 'public' })
      .expect(400);
  });

  it('private project surfaces in GET /api/projects under bypass', async () => {
    // The localBypass path (no-auth-configured test env) sees every project.
    const id = `vis-listed-${Date.now()}`;
    await request
      .post('/api/projects')
      .send({ id, name: 'Listed', cwd: '/tmp', visibility: 'private' })
      .expect(201);
    const res = await request.get('/api/projects').expect(200);
    const found = (res.body as Array<{ id: string }>).find((p) => p.id === id);
    expect(found).toBeDefined();
  });
});

describe('GET /api/admin/projects', () => {
  it('returns the admin row shape with visibility metadata', async () => {
    const shared = await createProject({ id: `admin-shared-${Date.now()}` });
    const privateId = `admin-private-${Date.now()}`;
    await request
      .post('/api/projects')
      .send({ id: privateId, name: 'Priv', cwd: '/tmp', visibility: 'private' })
      .expect(201);

    const res = await request.get('/api/admin/projects').expect(200);
    const rows = res.body as Array<{
      id: string;
      name: string;
      visibility: string;
      ownerUserId: string | null;
      ownerUsername: string | null;
      canEnter: boolean;
      agentCount: number;
    }>;

    const sharedRow = rows.find((r) => r.id === shared.id);
    const privateRow = rows.find((r) => r.id === privateId);
    expect(sharedRow).toBeDefined();
    expect(sharedRow!.visibility).toBe('shared');
    expect(privateRow).toBeDefined();
    expect(privateRow!.visibility).toBe('private');

    // Under bypass every row reports canEnter=true. The cross-user case
    // (Owner sees but can't enter) is covered in the unit tests.
    for (const r of rows) {
      expect(r.canEnter).toBe(true);
      expect(typeof r.agentCount).toBe('number');
    }
  });
});

describe('DELETE /api/projects/:projectId — visibility', () => {
  it('owner of bypass context can delete a private project', async () => {
    const id = `vis-delete-${Date.now()}`;
    await request
      .post('/api/projects')
      .send({ id, name: 'ToDelete', cwd: '/tmp', visibility: 'private' })
      .expect(201);
    await request.delete(`/api/projects/${id}`).expect(204);

    const after = await request.get('/api/projects').expect(200);
    const found = (after.body as Array<{ id: string }>).find((p) => p.id === id);
    expect(found).toBeUndefined();
  });
});
