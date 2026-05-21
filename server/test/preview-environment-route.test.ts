import { describe, it, expect, beforeAll, vi } from 'vitest';
import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';

let request: supertest.Agent;
let adminJwt: string;
let userJwt: string;

beforeAll(async () => {
  request = await getRequest();
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'preview-env-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  const orgId = getActiveOrgId();
  const userRow = createUser({
    username: `preview-env-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });
  const adminRow = createUser({
    username: `preview-env-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

describe('GET /api/projects/:id/preview/environment-draft', () => {
  it('404 for unknown project', async () => {
    await request
      .get('/api/projects/no-such/preview/environment-draft')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(404);
  });

  it('403 for User role', async () => {
    await request
      .get('/api/projects/no-such/preview/environment-draft')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(403);
  });
});

describe('POST /api/projects/:id/preview/build', () => {
  it('403 for User role', async () => {
    await request
      .post('/api/projects/no-such/preview/build')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ compose: { entryService: 'web', entryPort: 3000 } })
      .expect(403);
  });

  it('400 when compose file missing and no yaml provided', async () => {
    const id = `pe-build-${Date.now()}`;
    await request
      .post('/api/projects')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
      .expect(201);
    const res = await request
      .post(`/api/projects/${id}/preview/build`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        compose: { entryService: 'web', entryPort: 3000 },
      });
    expect(res.status).toBe(400);
  });
});
