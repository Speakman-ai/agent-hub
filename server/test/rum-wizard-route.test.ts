/**
 * Integration tests for the AI RUM setup wizard route.
 *
 *   GET /api/projects/:projectId/rum/setup-draft   (Admin+)
 *
 * Covers:
 *   - role gate (403 for a User-role caller)
 *   - 404 when the project does not exist
 *   - happy path returns { projectId, draft } with detected framework
 *
 * No CLI binaries are spawned; this endpoint is read-only and only scans
 * files under the project cwd.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'rum-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `rum-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `rum-wizard-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

let _counter = 0;
function uid(prefix = 'rum-wizard'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(cwd: string): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd, color: '#3B82F6' })
    .expect(201);
  return (res.body as { id: string }).id;
}

describe('GET /api/projects/:projectId/rum/setup-draft', () => {
  it('403 when caller is below the Admin role', async () => {
    const res = await request
      .get('/api/projects/any-id/rum/setup-draft')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/no-such-project/rum/setup-draft')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it('happy path returns the detection draft for a Next.js app', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'ah-rum-cwd-'));
    writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { next: '14.0.0', react: '18.2.0' } }),
    );
    writeFileSync(path.join(cwd, 'package-lock.json'), '{}');
    writeFileSync(path.join(cwd, 'tsconfig.json'), '{}');
    mkdirSync(path.join(cwd, 'app'), { recursive: true });
    writeFileSync(path.join(cwd, 'app', 'layout.tsx'), 'export default function L() {}');

    const projectId = await makeProject(cwd);

    const res = await request
      .get(`/api/projects/${projectId}/rum/setup-draft`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    expect(res.body.projectId).toBe(projectId);
    expect(res.body.draft.framework).toBe('next');
    expect(res.body.draft.packageManager).toBe('npm');
    expect(res.body.draft.typescript).toBe(true);
    expect(res.body.draft.plan.targetFile).toBe('app/layout.tsx');
    // Next app-router layout is a Server Component → client-component insertion.
    expect(res.body.draft.plan.injectionStyle).toBe('client-component');
  });
});
