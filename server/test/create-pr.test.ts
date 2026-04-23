import type supertest from 'supertest';
import { getRequest, createSession, createProject, createAgent } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/sessions/:sessionId/create-pr', () => {
  it('returns 404 for a non-existent session', async () => {
    const res = await request
      .post('/api/sessions/non-existent-id/create-pr')
      .send({ autoMerge: false });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when session has no worktree', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: false });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no worktree/i);
  });

  it('returns 403 when the project is in workflow mode', async () => {
    const proj = await createProject();
    await request.patch(`/api/projects/${proj.id}`).send({ mode: 'workflow' }).expect(200);
    const agent = await createAgent({ projectId: String(proj.id) });
    const session = await createSession({ agentId: agent.id as string });
    const res = await request.post(`/api/sessions/${session.id}/create-pr`).send({});
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/workflow mode/i);
  });

  it('accepts autoMerge boolean and title string', async () => {
    // Session without worktree — will fail at 400, but validates the body parsing
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: true, title: 'Fix the bug' });
    // Should fail with no-worktree before reaching git operations
    expect(res.status).toBe(400);
  });

  it('accepts autoMerge=true in the body without crashing', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: true });
    // Still short-circuits on the missing worktree, but the endpoint must
    // not reject requests that include an explicit opt-in.
    expect(res.status).toBe(400);
  });

  it('accepts explicit autoMerge=false (opt-out) in the body', async () => {
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: false });
    expect(res.status).toBe(400);
  });

  it('accepts a body with no autoMerge field (falls through to project default)', async () => {
    const session = await createSession();
    const res = await request.post(`/api/sessions/${session.id}/create-pr`).send({});
    expect(res.status).toBe(400);
  });
});
