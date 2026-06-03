import { describe, it, expect, beforeAll } from 'vitest';
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
    username: 'finalize-env-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  const orgId = getActiveOrgId();
  const userRow = createUser({
    username: `finalize-env-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });
  const adminRow = createUser({
    username: `finalize-env-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

describe('GET /api/projects/:id/finalize/environment-draft', () => {
  it('404 for unknown project', async () => {
    await request
      .get('/api/projects/no-such/finalize/environment-draft')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(404);
  });

  it('403 for User role', async () => {
    await request
      .get('/api/projects/no-such/finalize/environment-draft')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(403);
  });
});
