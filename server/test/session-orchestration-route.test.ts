import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'orch-route-agent',
    name: 'Orchestration Route Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

describe('GET /api/sessions/:sessionId — orchestration', () => {
  it('includes orchestrationMeta parsed (null when unset)', async () => {
    const session = await createSession({ agentId, name: 'orch-get' });
    const sessionId = session.id as string;
    const res = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(res.body.orchestration_phase ?? null).toBeNull();
    expect(res.body.orchestration_meta ?? null).toBeNull();
    expect(res.body.orchestrationMeta).toBeNull();
  });
});

describe('PUT /api/sessions/:sessionId/orchestration', () => {
  it('returns 400 when body is empty', async () => {
    const session = await createSession({ agentId, name: 'orch-empty-body' });
    const sessionId = session.id as string;
    await request.put(`/api/sessions/${sessionId}/orchestration`).send({}).expect(400);
  });

  it('returns 404 for unknown session id', async () => {
    await request
      .put('/api/sessions/00000000-0000-4000-8000-000000000099/orchestration')
      .send({ phase: 'planning' })
      .expect(404);
  });

  it('returns 400 for invalid phase string', async () => {
    const session = await createSession({ agentId, name: 'orch-bad-phase' });
    const sessionId = session.id as string;
    await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: 'floating' })
      .expect(400);
  });

  it('sets phase and meta and returns enriched JSON', async () => {
    const session = await createSession({ agentId, name: 'orch-set' });
    const sessionId = session.id as string;
    const res = await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: 'verifying', meta: { pr: 42 } })
      .expect(200);
    expect(res.body.orchestration_phase).toBe('verifying');
    expect(res.body.orchestration_meta).toContain('"pr":42');
    expect(res.body.orchestrationMeta).toEqual({ pr: 42 });

    const get = await request.get(`/api/sessions/${sessionId}`).expect(200);
    expect(get.body.orchestration_phase).toBe('verifying');
    expect(get.body.orchestrationMeta).toEqual({ pr: 42 });
  });

  it('updates only meta when phase omitted', async () => {
    const session = await createSession({ agentId, name: 'orch-partial-meta' });
    const sessionId = session.id as string;
    await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: 'acting', meta: { step: 1 } })
      .expect(200);
    const res = await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ meta: { step: 2 } })
      .expect(200);
    expect(res.body.orchestration_phase).toBe('acting');
    expect(res.body.orchestrationMeta).toEqual({ step: 2 });
  });

  it('clears phase when phase null sent', async () => {
    const session = await createSession({ agentId, name: 'orch-clear-phase' });
    const sessionId = session.id as string;
    await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: 'planning' })
      .expect(200);
    const res = await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: null })
      .expect(200);
    expect(res.body.orchestration_phase).toBeNull();
  });

  it('clears meta when meta null sent after it was set', async () => {
    const session = await createSession({ agentId, name: 'orch-clear-meta' });
    const sessionId = session.id as string;
    await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ phase: 'acting', meta: { step: 1 } })
      .expect(200);
    const res = await request
      .put(`/api/sessions/${sessionId}/orchestration`)
      .send({ meta: null })
      .expect(200);
    expect(res.body.orchestration_meta).toBeNull();
    expect(res.body.orchestrationMeta).toBeNull();
    expect(res.body.orchestration_phase).toBe('acting');
  });
});
