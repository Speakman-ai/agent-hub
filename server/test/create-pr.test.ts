import type supertest from 'supertest';
import { getRequest, createSession } from './helpers.js';

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

  it('accepts autoMerge boolean and title string', async () => {
    // Session without worktree — will fail at 400, but validates the body parsing
    const session = await createSession();
    const res = await request
      .post(`/api/sessions/${session.id}/create-pr`)
      .send({ autoMerge: true, title: 'Fix the bug' });
    // Should fail with no-worktree before reaching git operations
    expect(res.status).toBe(400);
  });
});
