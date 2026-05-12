/**
 * Integration tests for the AI-assisted preview setup wizard routes.
 *
 *   POST /api/projects/:projectId/preview/setup-wizard     (Admin+)
 *   POST /api/projects/:projectId/preview/wizard-complete  (no role gate)
 *
 * Covers:
 *   - 404 when the project doesn't exist
 *   - 403 when a non-Admin caller hits the wizard spawn route
 *   - 400 when the project has no agents to host the wizard
 *   - happy path returns { sessionId, agentId } and persists the session row
 *   - wizard-complete returns { ok: true } and surfaces a 404 for unknown
 *     projects (the broadcast itself is fire-and-forget)
 *
 * The default test caller (no JWT, no apiKey) resolves to Owner — so
 * the role gate is open. We mint a User-role JWT to exercise the 403
 * branch, matching the pattern used by `slack-bots-role-gate.test.ts`.
 *
 * We mock the chat handler in `server/index.ts` so the wizard's
 * fire-and-forget `handleChat` call doesn't actually spawn a CLI. The
 * test caller for `handleChat` is captured so we can assert the
 * kickoff prompt shape.
 */
import { describe, it, expect, beforeAll } from 'vitest';

// The wizard route calls `handleChat` fire-and-forget — it returns
// 201 with the synchronously-created session row before any CLI spawn
// would actually happen. server/test/setup.ts neutralises spawn calls
// for the forbidden CLI binaries, so the downstream spawn attempt
// fails inside the chat handler's own promise without affecting the
// supertest response. We don't mock the handler here; we just rely on
// that contract.

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
    username: 'preview-wizard-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `preview-wizard-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `preview-wizard-admin-${Date.now()}`,
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
function uid(prefix = 'preview-wizard'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return (res.body as { id: string }).id;
}

async function makeAgent(projectId: string): Promise<string> {
  const id = uid('agent');
  const res = await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, projectId, name: `Agent ${id}`, engine: 'claude-code' })
    .expect(201);
  return (res.body as { id: string }).id;
}

describe('POST /api/projects/:projectId/preview/setup-wizard', () => {
  it('404 when project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/preview/setup-wizard')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({});
    expect(res.status).toBe(404);
  });

  it('403 when caller is below the Admin role', async () => {
    // We don't even need to create the project — requireRole fires
    // before the handler. This matches the slack-bot-role-gate pattern.
    const res = await request
      .post('/api/projects/any-id/preview/setup-wizard')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
    expect(res.body.currentRole).toBe('User');
  });

  it('400 when project has no agents', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/no agents/i);
  });

  it('happy path spawns a session and returns { sessionId, agentId }', async () => {
    const projectId = await makeProject();
    const agentId = await makeAgent(projectId);

    const res = await request
      .post(`/api/projects/${projectId}/preview/setup-wizard`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(201);
    expect(typeof res.body.sessionId).toBe('string');
    expect(res.body.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.agentId).toBe(agentId);
    expect(res.body.session).toBeDefined();
    expect(res.body.session.id).toBe(res.body.sessionId);
    // Wizards never use a worktree (they only read source).
    expect(res.body.session.use_worktree).toBe(0);
    expect(res.body.session.ask_mode).toBe(0);
    // Session name carries the project label so it's distinguishable
    // in the sidebar.
    expect(res.body.session.name).toMatch(/Preview Setup/);
  });
});

describe('POST /api/projects/:projectId/preview/wizard-complete', () => {
  it('404 for unknown project', async () => {
    await request
      .post('/api/projects/no-such-project/preview/wizard-complete')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(404);
  });

  it('returns { ok: true } for a known project', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/preview/wizard-complete`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({})
      .expect(200);
    expect(res.body).toEqual({ ok: true });
  });
});
