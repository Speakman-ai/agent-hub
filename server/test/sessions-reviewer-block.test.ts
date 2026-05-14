/**
 * Regression test for the reviewer-agent session-creation block.
 *
 * Reviewer agents (role === 'reviewer') are spawned exclusively by the
 * GitHub PR webhook (`server/routes/webhooks.ts:runReviewerDispatch`).
 * The thread is a shared, read-only artifact tied to a specific PR;
 * users may not start ad-hoc sessions with the reviewer. This file
 * exercises every server-side creation surface and asserts it 403s
 * (or otherwise refuses) for reviewer agents while still accepting
 * non-reviewer agents under the same fixtures.
 */
import type supertest from 'supertest';
import { getRequest, createAgent } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/agents/:agentId/sessions — reviewer block', () => {
  it('refuses to create a session for a reviewer agent (403)', async () => {
    const reviewer = await createAgent({ role: 'reviewer' });
    const res = await request
      .post(`/api/agents/${reviewer.id as string}/sessions`)
      .send({ name: 'should not exist' })
      .expect(403);
    expect((res.body as { error: string }).error).toMatch(/reviewer/i);
    expect((res.body as { error: string }).error).toMatch(/webhook|cannot be started/i);
  });

  it('still creates a session for a non-reviewer agent under the same fixture', async () => {
    const agent = await createAgent({ role: 'lead' });
    const res = await request
      .post(`/api/agents/${agent.id as string}/sessions`)
      .send({ name: 'fine' })
      .expect(200);
    expect((res.body as { id: string }).id).toMatch(/[0-9a-f-]{36}/);
  });
});

describe('POST /api/tasks — reviewer block', () => {
  it('refuses to create a background task targeting a reviewer agent (403)', async () => {
    const reviewer = await createAgent({ role: 'reviewer' });
    const res = await request
      .post('/api/tasks')
      .send({ agentId: reviewer.id, prompt: 'review this' })
      .expect(403);
    expect((res.body as { error: string }).error).toMatch(/reviewer/i);
  });

  it('returns 404 for an unknown agent (unchanged behaviour)', async () => {
    await request.post('/api/tasks').send({ agentId: 'no-such-agent', prompt: 'x' }).expect(404);
  });
});
