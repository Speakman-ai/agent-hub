import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'react-loop-route-agent',
    name: 'React Loop Route Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

describe('PUT /api/sessions/:sessionId/react-loop', () => {
  it('returns 400 when enabled is not a boolean', async () => {
    const session = await createSession({ agentId, name: 'react-loop-bad-body' });
    const sessionId = session.id as string;
    await request.put(`/api/sessions/${sessionId}/react-loop`).send({ enabled: 'yes' }).expect(400);
  });

  it('returns 404 for unknown session id', async () => {
    await request
      .put('/api/sessions/00000000-0000-4000-8000-000000000099/react-loop')
      .send({ enabled: false })
      .expect(404);
  });

  it('updates react_loop_enabled and returns the session row', async () => {
    const session = await createSession({ agentId, name: 'react-loop-toggle' });
    const sessionId = session.id as string;
    const off = await request
      .put(`/api/sessions/${sessionId}/react-loop`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.react_loop_enabled).toBe(0);

    const on = await request
      .put(`/api/sessions/${sessionId}/react-loop`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.react_loop_enabled).toBe(1);
  });
});
