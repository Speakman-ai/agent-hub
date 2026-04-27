/**
 * Integration tests for the /api/runners endpoints. Boots the full
 * Express app via getRequest() so we exercise the same middleware chain
 * (cors, auth passthrough in test mode, body parsing) as production.
 */
import type supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { getRequest } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

beforeEach(() => {
  // Each case starts with an empty runners table.
  getDb().exec('DELETE FROM runners');
});

describe('POST /api/runners', () => {
  it('creates a runner and returns the plaintext token exactly once', async () => {
    const res = await request
      .post('/api/runners')
      .send({ name: 'alice-laptop', orgId: 'default' })
      .expect(201);
    expect(res.body.runner.id).toBeTruthy();
    expect(res.body.runner.name).toBe('alice-laptop');
    expect(res.body.runner.orgId).toBe('default');
    expect(res.body.runner.status).toBe('offline');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBe(43);
  });

  it('does not include the token on subsequent reads', async () => {
    const created = await request
      .post('/api/runners')
      .send({ name: 'r1', orgId: 'default' })
      .expect(201);
    const fetched = await request.get(`/api/runners/${created.body.runner.id}`).expect(200);
    expect(fetched.body.token).toBeUndefined();
    expect(fetched.body.id).toBe(created.body.runner.id);
  });

  it('persists capabilities when provided', async () => {
    const res = await request
      .post('/api/runners')
      .send({
        name: 'r2',
        orgId: 'default',
        capabilities: { os: 'linux', engines: ['claude'] },
      })
      .expect(201);
    expect(res.body.runner.capabilities).toEqual({ os: 'linux', engines: ['claude'] });
  });

  it('rejects missing name with 400', async () => {
    await request.post('/api/runners').send({ orgId: 'default' }).expect(400);
  });

  it('rejects empty / whitespace name with 400', async () => {
    await request.post('/api/runners').send({ name: '   ' }).expect(400);
  });

  it('rejects names longer than 128 chars with 400', async () => {
    await request
      .post('/api/runners')
      .send({ name: 'x'.repeat(129) })
      .expect(400);
  });

  it('returns 409 on duplicate (org, name)', async () => {
    await request.post('/api/runners').send({ name: 'dup', orgId: 'default' }).expect(201);
    await request.post('/api/runners').send({ name: 'dup', orgId: 'default' }).expect(409);
  });

  it('rejects array as capabilities (must be a plain object)', async () => {
    const res = await request
      .post('/api/runners')
      .send({ name: 'r3', capabilities: ['nope'] })
      .expect(201);
    // Arrays are silently ignored — not a hard error, but they don't persist.
    expect(res.body.runner.capabilities).toEqual({});
  });
});

describe('GET /api/runners', () => {
  it('lists runners in the active org by default', async () => {
    await request.post('/api/runners').send({ name: 'a', orgId: 'default' }).expect(201);
    await request.post('/api/runners').send({ name: 'b', orgId: 'default' }).expect(201);
    const res = await request.get('/api/runners').expect(200);
    expect(res.body.runners.map((r: { name: string }) => r.name).sort()).toEqual(['a', 'b']);
  });

  it('filters by ?orgId=…', async () => {
    await request.post('/api/runners').send({ name: 'a', orgId: 'default' }).expect(201);
    await request.post('/api/runners').send({ name: 'b', orgId: 'other-org' }).expect(201);
    const res = await request.get('/api/runners?orgId=other-org').expect(200);
    expect(res.body.runners.map((r: { name: string }) => r.name)).toEqual(['b']);
  });

  it('returns empty list when no runners exist', async () => {
    const res = await request.get('/api/runners').expect(200);
    expect(res.body.runners).toEqual([]);
  });
});

describe('GET /api/runners/:id', () => {
  it('returns 404 for unknown id', async () => {
    await request.get('/api/runners/no-such-id').expect(404);
  });
});

describe('DELETE /api/runners/:id', () => {
  it('deletes a runner and 204s', async () => {
    const created = await request
      .post('/api/runners')
      .send({ name: 'doomed', orgId: 'default' })
      .expect(201);
    await request.delete(`/api/runners/${created.body.runner.id}`).expect(204);
    await request.get(`/api/runners/${created.body.runner.id}`).expect(404);
  });

  it('returns 404 for unknown id', async () => {
    await request.delete('/api/runners/nope').expect(404);
  });
});

describe('cross-org authorization (JWT auth configured)', () => {
  // Stand up two `remote`-mode orgs (so the local-org bypass doesn't fire),
  // seed three real users with disjoint memberships, sign Bearer tokens,
  // and verify `requireOrgMembership` enforces:
  //   - non-member is rejected with 403 on every route
  //   - User-role member can list/read but cannot mint or revoke
  //   - Owner-role member can mint, list, read, revoke
  //   - GET/:id and DELETE/:id resolve org via the runner row, so a known
  //     runner id from another org still 403s instead of leaking
  // This exercises the JWT-authenticated path end-to-end through the real
  // auth middleware — the existing tests above run anonymous-Owner.
  const ORG_A = 'runners-auth-org-a';
  const ORG_B = 'runners-auth-org-b';
  const JWT_SECRET = 'd'.repeat(64);
  let restoreAuth: () => void = () => {};
  let aliceToken = '';
  let bobToken = '';
  let carolToken = '';

  beforeAll(async () => {
    const { unlinkSync, existsSync } = await import('fs');
    const path = await import('path');
    const { saveAuthRecord, reloadAuthRecord } = await import('../auth-store.js');
    const config = (await import('../config.js')).default;
    const authPath = path.join(config.dataDir, 'auth.json');
    const { signJwt } = await import('../jwt.js');
    const { createUser } = await import('../users-store.js');
    const { createMembership } = await import('../memberships-store.js');
    const { getOrgsDb } = await import('../orgs.js');

    saveAuthRecord({
      username: 'first-owner',
      passwordHash: 'scrypt$deadbeef',
      jwtSecret: JWT_SECRET,
    });

    const orgsDb = getOrgsDb();
    const upsertOrg = orgsDb.prepare(
      `INSERT INTO orgs (id, name, mode, color, remote_url, api_key, position)
       VALUES (?, ?, 'remote', '#6366f1', '', '', 0)
       ON CONFLICT(id) DO UPDATE SET mode = 'remote'`,
    );
    upsertOrg.run(ORG_A, 'Auth Test Org A');
    upsertOrg.run(ORG_B, 'Auth Test Org B');

    // Switch active org away from `default` so isActiveOrgLocal() doesn't
    // short-circuit the entire auth middleware. We don't care which of
    // the new orgs is active; pick A.
    orgsDb
      .prepare("INSERT OR REPLACE INTO active_org (key, org_id) VALUES ('active', ?)")
      .run(ORG_A);

    const alice = createUser({ username: 'alice', passwordHash: 'x' });
    const bob = createUser({ username: 'bob', passwordHash: 'x' });
    const carol = createUser({ username: 'carol', passwordHash: 'x' });

    // Alice — Owner in A only. Bob — Owner in B only (cross-org probe at
    // A must be rejected). Carol — User in A (no Admin power).
    createMembership(alice.id, ORG_A, 'Owner');
    createMembership(bob.id, ORG_B, 'Owner');
    createMembership(carol.id, ORG_A, 'User');

    aliceToken = signJwt(alice.username, JWT_SECRET, { claims: { uid: alice.id } });
    bobToken = signJwt(bob.username, JWT_SECRET, { claims: { uid: bob.id } });
    carolToken = signJwt(carol.username, JWT_SECRET, { claims: { uid: carol.id } });

    restoreAuth = (): void => {
      try {
        if (existsSync(authPath)) unlinkSync(authPath);
      } catch {
        /* ignore */
      }
      reloadAuthRecord();
      // Restore active org so later test files aren't surprised.
      orgsDb
        .prepare("INSERT OR REPLACE INTO active_org (key, org_id) VALUES ('active', ?)")
        .run('default');
    };
  });

  afterAll(() => restoreAuth());

  it('allows an Owner of the target org to POST /api/runners', async () => {
    const res = await request
      .post('/api/runners')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ name: 'alice-runner', orgId: ORG_A })
      .expect(201);
    expect(res.body.runner.orgId).toBe(ORG_A);
  });

  it('rejects a non-member POST with 403 (cross-org token issuance attempt)', async () => {
    // Bob is Owner of B but has no membership in A — must be rejected.
    const res = await request
      .post('/api/runners')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ name: 'bob-cross-org', orgId: ORG_A })
      .expect(403);
    expect(res.body.error).toMatch(/not a member/i);
  });

  it('rejects a User-role member POST with 403 (Admin required for mint)', async () => {
    // Carol is a User in A — she's a member, but token issuance must
    // require Admin or higher.
    const res = await request
      .post('/api/runners')
      .set('Authorization', `Bearer ${carolToken}`)
      .send({ name: 'carol-runner', orgId: ORG_A })
      .expect(403);
    expect(res.body.error).toMatch(/Admin/i);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('lets a User-role member GET /api/runners?orgId=…', async () => {
    // Listing is scoped to any-member, not Admin.
    await request
      .get(`/api/runners?orgId=${ORG_A}`)
      .set('Authorization', `Bearer ${carolToken}`)
      .expect(200);
  });

  it('rejects a non-member GET /api/runners?orgId=… with 403', async () => {
    await request
      .get(`/api/runners?orgId=${ORG_A}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(403);
  });

  it('rejects GET /api/runners/:id from a non-member by resolving runner.orgId', async () => {
    // Seed a runner in A directly via the store so we have a known id.
    const { createRunner } = await import('../runners-store.js');
    const { runner } = createRunner({ orgId: ORG_A, name: 'gated-get' });
    try {
      await request
        .get(`/api/runners/${runner.id}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(403);
      // Owner of the runner's org can read it.
      await request
        .get(`/api/runners/${runner.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(200);
    } finally {
      getDb().prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
    }
  });

  it('rejects DELETE /api/runners/:id from a non-member by resolving runner.orgId', async () => {
    const { createRunner } = await import('../runners-store.js');
    const { runner } = createRunner({ orgId: ORG_A, name: 'gated-del' });
    try {
      await request
        .delete(`/api/runners/${runner.id}`)
        .set('Authorization', `Bearer ${bobToken}`)
        .expect(403);
      // Carol is User in A — revocation is also Admin-gated, so 403.
      await request
        .delete(`/api/runners/${runner.id}`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(403);
      // Owner can delete it.
      await request
        .delete(`/api/runners/${runner.id}`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(204);
    } finally {
      getDb().prepare('DELETE FROM runners WHERE id = ?').run(runner.id);
    }
  });

  it('still 404s on unknown :id (row resolution runs before auth gate)', async () => {
    // The id is an opaque uuid, so a 404-vs-403 distinction reveals
    // nothing meaningful — and resolving the row first is what lets us
    // gate by `runner.orgId`.
    await request
      .get('/api/runners/no-such-id')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(404);
  });
});
