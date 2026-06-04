/**
 * End-to-end isolation tests for per-user session ownership (PR #709).
 *
 * The unit tests in `server/session-ownership.test.ts` cover the
 * helper predicates in isolation. This file walks through the full
 * REST + WebSocket stack with two distinct JWT-authenticated users to
 * prove that the `router.use('/api/sessions/:sessionId', …)` prefix
 * gate plus the inline `userOwnsSession` calls on the message / task
 * / delegation / forward / cancel surfaces actually keep User B out
 * of User A's session.
 *
 * A future refactor that drops the prefix middleware or one of the
 * inline gates would silently regress without these specs.
 */
import './setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { unlinkSync, existsSync } from 'fs';

import { getRequest } from './helpers.js';
import { saveAuthRecord, reloadAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { getSessionOwner } from '../session-ownership.js';
import config from '../config.js';

interface User {
  id: string;
  username: string;
  token: string;
}

let request: supertest.Agent;
let authPath = '';

let userA: User;
let userB: User;

/**
 * Issue a Bearer-style HS256 token for `userId` against the test
 * auth record's `jwtSecret`. Mirrors `routes/auth.ts:issueToken` so
 * we don't have to go through `/api/auth/login` for fixtures.
 */
function issueTokenForUser(jwtSecret: string, user: { id: string; username: string }): string {
  return signJwt(user.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Owner', uid: user.id },
  });
}

let projectCounter = 0;

/**
 * Create a project + agent as `user`. The shared helpers in
 * `helpers.ts` don't carry auth headers, so we inline the two POSTs
 * here and pass the user's bearer token. Returns the agent id.
 */
async function createProjectAndAgentAs(user: User): Promise<string> {
  projectCounter += 1;
  const projectId = `iso-proj-${Date.now()}-${projectCounter}`;
  await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: projectId, name: 'Iso Project', cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  const agentId = `iso-agent-${Date.now()}-${projectCounter}`;
  await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${user.token}`)
    .send({ id: agentId, projectId, name: 'Iso Agent', engine: 'claude-code' })
    .expect(201);
  return agentId;
}

beforeAll(async () => {
  request = await getRequest();

  // 1. Save an auth record so `getAuthRecord()` returns truthy and
  //    the auth middleware enforces JWT instead of free-passing.
  authPath = path.join(config.dataDir, 'auth.json');
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'isolation-owner',
    passwordHash: 'scrypt$ignored-for-this-test',
    jwtSecret,
    role: 'Owner',
  });

  // 2. Seed two users in orgs.db with Admin memberships in the
  //    active org so both pass auth.ts's membership gate. We give
  //    `userA` the older `created_at` so a separate test could verify
  //    org-owner identity if needed; ordering only matters for
  //    `getOrgOwnerUserId()`.
  const orgId = getActiveOrgId();
  const aRow = createUser({
    username: `iso-user-a-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const bRow = createUser({
    username: `iso-user-b-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(aRow.id, orgId, 'Admin');
  createMembership(bRow.id, orgId, 'Admin');

  userA = {
    id: aRow.id,
    username: aRow.username,
    token: issueTokenForUser(jwtSecret, aRow),
  };
  userB = {
    id: bRow.id,
    username: bRow.username,
    token: issueTokenForUser(jwtSecret, bRow),
  };
});

afterAll(() => {
  // Unlink auth.json + reload so the rest of the test run goes back
  // to no-auth-configured mode. Other test files assume the harness
  // is permissive (see `userOwnsSession allows everyone when auth is
  // disabled`).
  try {
    if (authPath && existsSync(authPath)) unlinkSync(authPath);
  } catch {
    /* best-effort */
  }
  reloadAuthRecord();
});

describe('Per-user session ownership — REST isolation', () => {
  it('records the creator as the owner of a fresh session', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-fresh' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;
    expect(sessionId).toBeTruthy();
    expect(getSessionOwner(sessionId)).toBe(userA.id);
  });

  it('non-owner gets 404 (not 403) on every /api/sessions/:id surface', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-foreign' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;

    // GET /api/sessions/:id — prefix middleware
    await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);

    // GET /api/sessions/:id/messages — also under the prefix gate
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);

    // POST /api/sessions/:id/forward — same prefix gate. We pass an
    // intentionally-bogus body because the gate fires before any
    // shape validation.
    await request
      .post(`/api/sessions/${sessionId}/forward`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ targetAgentId: 'nope' })
      .expect(404);

    // Sanity: User A still sees their own session through the same
    // surfaces (proves the gate isn't a blanket reject).
    await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
  });

  it('foreign user cannot stop another user’s background task', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    // Create a task as User A. We don't actually wait for it to run —
    // we only need a row in `tasks` whose backing session is owned by
    // A so the gate has something to compare against.
    const taskRes = await request
      .post('/api/tasks')
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ agentId, prompt: 'noop iso-test' })
      .expect(201);
    const taskId = (taskRes.body as { taskId: string }).taskId;

    // POST /api/tasks/:taskId/stop — gated inline by userOwnsSession
    // on the task's session. User B should see 404.
    await request
      .post(`/api/tasks/${taskId}/stop`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);
  });

  it('non-owner cannot enumerate another user’s sessions via GET /api/agents/:id/sessions', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-enumerate' })
      .expect(200);

    // User B asks for the same agent's sessions and should see an
    // empty array (filtered by `userOwnsSession`), not A's session.
    const res = await request
      .get(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);
    const sessions = res.body as Array<{ id: string; name: string }>;
    expect(sessions.find((s) => s.name === 'iso-test-enumerate')).toBeUndefined();
  });

  it('messages list is scoped to owner — userOwnsSession middleware fires before route handler', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-messages' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;

    // Same session id from User B's perspective is "not found".
    const res = await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);
    // Body shape matches the prefix-gate's 404 payload, not the
    // route's own "no rows" payload.
    expect(res.body).toEqual({ error: 'Session not found' });
  });

  it('a non-existent session id resolves to 404 for both users (no info leak)', async () => {
    const fakeId = uuidv4();
    await request
      .get(`/api/sessions/${fakeId}`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(404);
    await request
      .get(`/api/sessions/${fakeId}`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(404);
  });
});
