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
// (createMembership role arg drives the org-admin read grace under test.)
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
// A plain (non-admin) org member. Used to prove the org-admin read grace
// does NOT extend to the `User` role — a plain member still cannot read a
// session they do not own.
let userC: User;

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
  const cRow = createUser({
    username: `iso-user-c-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-03T00:00:00Z',
  });
  createMembership(aRow.id, orgId, 'Admin');
  createMembership(bRow.id, orgId, 'Admin');
  createMembership(cRow.id, orgId, 'User');

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
  userC = {
    id: cRow.id,
    username: cRow.username,
    token: issueTokenForUser(jwtSecret, cRow),
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

  it('org admin non-owner can READ but not MUTATE another user’s session; plain user is blocked entirely', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-foreign' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;

    // User B is an org Admin. Under the org-admin read grace they may
    // OPEN (deep-link) a session they don't own, even though it is hidden
    // from their owner-only sidebar. GET /api/sessions/:id — prefix gate.
    await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    // GET /api/sessions/:id/messages — same read gate, also granted.
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    // ...but MUTATIONS stay strictly owner-only. The read grace lives in
    // `userCanReadSession`, not `userOwnsSession`, so an admin non-owner
    // still 404s on write surfaces. POST /forward (bogus body — the gate
    // fires before shape validation).
    await request
      .post(`/api/sessions/${sessionId}/forward`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ targetAgentId: 'nope' })
      .expect(404);

    // POST /api/sessions/:id/follow-up — same write gate.
    await request
      .post(`/api/sessions/${sessionId}/follow-up`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({})
      .expect(404);

    // User C is a plain (non-admin) member. The read grace does NOT extend
    // to the `User` role, so even reads 404 (not 403 — no existence probe).
    await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userC.token}`)
      .expect(404);
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userC.token}`)
      .expect(404);

    // Sanity: User A still sees their own session (gate isn't a blanket reject).
    await request
      .get(`/api/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userA.token}`)
      .expect(200);
  });

  // The follow-up route reads the source session's transcript, its Finalize
  // summary, and its PR url, then inherits its owner — so a gate regression
  // here is an exfiltration primitive, not just an unauthorized write.
  //
  // The project is created by User B and the session by User A on purpose.
  // The route's own `canViewProject` check runs against the *default target
  // agent*, which is the source session's agent — so when the project is
  // private to A, that check masks the result and the test would pass even
  // with the session gate removed (verified: it did). Giving B the project
  // outright strips that cover, leaving `userOwnsSession` in the prefix
  // middleware as the only thing between B and A's transcript. This is also
  // the realistic shape of the risk: teammates who share a project.
  it('foreign user cannot exfiltrate a session’s transcript via POST /follow-up', async () => {
    const agentId = await createProjectAndAgentAs(userB);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-followup' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;
    // Precondition: the session really is A's, on B's project.
    expect(getSessionOwner(sessionId)).toBe(userA.id);

    const SECRET = 'PROD_DB_PASSWORD=hunter2-iso-test';
    const { stmts } = await import('../db.js');
    if (!stmts) throw new Error('stmts not initialized');
    stmts.addMessage.run(
      uuidv4(),
      sessionId,
      'system',
      `## Finalize summary\n### Follow-ups\n- [ ] Run \`export ${SECRET}\` on prod`,
      null,
      null,
      null,
      JSON.stringify({
        kind: 'finalize_run_summary',
        runId: 'iso-run-1',
        followUps: [`Run \`export ${SECRET}\` on prod`],
      }),
      null,
      null,
      null,
    );

    const sessionsBefore = await request
      .get(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);

    const res = await request
      .post(`/api/sessions/${sessionId}/follow-up`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ prompt: 'continue this' })
      .expect(404);

    // No seeded session handed back, and nothing quoted in the error body.
    expect(res.body.session).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);

    // And no follow-up session was created behind the 404.
    const sessionsAfter = await request
      .get(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);
    expect(sessionsAfter.body).toHaveLength((sessionsBefore.body as unknown[]).length);
    expect(
      (sessionsAfter.body as Array<{ name?: string }>).some((s) =>
        (s.name ?? '').startsWith('[Follow-up]'),
      ),
    ).toBe(false);

    // Positive control, and the reason this test proves what it claims: B
    // branching from B's OWN session on the same agent succeeds. So B clears
    // the route's `canViewProject` check on this project, which means the 404
    // above can only have come from the session-ownership gate — not from
    // project visibility incidentally covering for it.
    const ownedByB = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({ name: 'iso-test-followup-own' })
      .expect(200);
    const ownFollowUp = await request
      .post(`/api/sessions/${(ownedByB.body as { id: string }).id}/follow-up`)
      .set('Authorization', `Bearer ${userB.token}`)
      .send({})
      .expect(201);
    expect(ownFollowUp.body.session.name).toContain('[Follow-up]');
    expect(getSessionOwner(ownFollowUp.body.session.id as string)).toBe(userB.id);
    // ...and it carries none of A's context.
    const seeded = await request
      .get(`/api/sessions/${ownFollowUp.body.session.id}/messages`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);
    expect(JSON.stringify(seeded.body)).not.toContain(SECRET);
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

  it('messages list is scoped to owner — plain User is blocked by the read gate before the handler', async () => {
    const agentId = await createProjectAndAgentAs(userA);
    const create = await request
      .post(`/api/agents/${agentId}/sessions`)
      .set('Authorization', `Bearer ${userA.token}`)
      .send({ name: 'iso-test-messages' })
      .expect(200);
    const sessionId = (create.body as { id: string }).id;

    // Same session id from a plain (non-admin) member's perspective is
    // "not found" — the org-admin read grace does not apply to `User`.
    const res = await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userC.token}`)
      .expect(404);
    // Body shape matches the prefix-gate's 404 payload, not the
    // route's own "no rows" payload.
    expect(res.body).toEqual({ error: 'Session not found' });

    // An org Admin, by contrast, is granted the read (200).
    await request
      .get(`/api/sessions/${sessionId}/messages`)
      .set('Authorization', `Bearer ${userB.token}`)
      .expect(200);
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
