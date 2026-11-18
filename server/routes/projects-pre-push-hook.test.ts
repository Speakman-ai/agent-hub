/**
 * Project.prePushHook PATCH validation and the Admin-person gate.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import config from '../config.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { createApiKey } from '../api-keys-store.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('prePushHook setting', () => {
  it('stores, merges and clears the hook', async () => {
    const projectId = (await createProject()).id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ prePushHook: { enabled: true, command: 'echo hi' } })
      .expect(200);
    const merged = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prePushHook: { timeoutSec: 60 } })
      .expect(200);
    expect(merged.body.prePushHook).toEqual({ enabled: true, command: 'echo hi', timeoutSec: 60 });

    const cleared = await request
      .patch(`/api/projects/${projectId}`)
      .send({ prePushHook: null })
      .expect(200);
    expect(cleared.body.prePushHook).toBeUndefined();
  });

  it('rejects malformed values without half-applying the PATCH', async () => {
    const projectId = (await createProject()).id as string;
    for (const bad of [true, [], { enabled: 'yes' }, { command: 3 }, { timeoutSec: 0 }]) {
      await request
        .patch(`/api/projects/${projectId}`)
        .send({ name: 'renamed', prePushHook: bad })
        .expect(400);
    }
    const after = await request.get(`/api/projects/${projectId}`).expect(200);
    expect(after.body.prePushHook).toBeUndefined();
    expect(after.body.name).not.toBe('renamed');
  });
});

describe('prePushHook permissions', () => {
  let originalApiKey: string | null;
  let projectId: string;
  let adminKey: string;
  let userJwt: string;
  let adminJwt: string;

  beforeAll(async () => {
    originalApiKey = config.apiKey;
    config.apiKey = null;
    projectId = (await createProject()).id as string;
    const jwtSecret = generateJwtSecret();
    saveAuthRecord({
      username: 'pph-owner',
      passwordHash: 'scrypt$ignored',
      jwtSecret,
      role: 'Owner',
    });
    const orgId = getActiveOrgId();
    const stamp = Date.now();
    const user = createUser({
      username: `pph-user-${stamp}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(user.id, orgId, 'User');
    userJwt = signJwt(user.username, jwtSecret, {
      expiresInSec: 3600,
      claims: { role: 'User', uid: user.id },
    });
    const admin = createUser({
      username: `pph-admin-${stamp}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(admin.id, orgId, 'Admin');
    adminKey = createApiKey(admin.id, 'pph-admin').token;
    adminJwt = signJwt(admin.username, jwtSecret, {
      expiresInSec: 3600,
      claims: { role: 'Admin', uid: admin.id },
    });
    config.apiKey = 'pre-push-hook-secret';
  }, 60_000);

  afterAll(() => {
    config.apiKey = originalApiKey;
  });

  const body = { prePushHook: { enabled: true, command: 'echo hi' } };

  it('refuses the global API key that spawned agents carry', async () => {
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .set('x-api-key', 'pre-push-hook-secret')
      .send(body)
      .expect(403);
    expect(res.body.code).toBe('pre_push_hook_requires_person');
  });

  it("refuses an Admin's personal API key", async () => {
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .set('x-api-key', adminKey)
      .send(body)
      .expect(403);
    expect(res.body.code).toBe('pre_push_hook_requires_person');
  });

  it('refuses a signed-in User and accepts a signed-in Admin', async () => {
    const denied = await request
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .send(body);
    expect(denied.status).toBe(403);

    const ok = await request
      .patch(`/api/projects/${projectId}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send(body)
      .expect(200);
    expect(ok.body.prePushHook).toEqual({ enabled: true, command: 'echo hi' });
  });
});
