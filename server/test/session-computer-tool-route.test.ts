import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createAgent, createSession } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const agent = await createAgent({
    id: 'computer-tool-route-agent',
    name: 'Computer Tool Route Agent',
    engine: 'claude-code',
  });
  agentId = agent.id as string;
});

describe('PUT /api/sessions/:sessionId/computer-tool', () => {
  it('starts unset, so new sessions inherit the off-by-default agent value', async () => {
    const session = await createSession({ agentId, name: 'computer-tool-default' });
    const row = await request.get(`/api/sessions/${session.id as string}`).expect(200);
    expect(row.body.computer_tool_enabled ?? null).toBeNull();
  });

  it('rejects a non-boolean body and unknown sessions', async () => {
    const session = await createSession({ agentId, name: 'computer-tool-bad-body' });
    await request
      .put(`/api/sessions/${session.id as string}/computer-tool`)
      .send({ enabled: 'yes' })
      .expect(400);
    await request
      .put('/api/sessions/00000000-0000-4000-8000-000000000099/computer-tool')
      .send({ enabled: true })
      .expect(404);
  });

  it('sets each session independently and clears back to the agent default', async () => {
    const a = (await createSession({ agentId, name: 'computer-tool-a' })).id as string;
    const b = (await createSession({ agentId, name: 'computer-tool-b' })).id as string;

    const on = await request
      .put(`/api/sessions/${a}/computer-tool`)
      .send({ enabled: true })
      .expect(200);
    expect(on.body.computer_tool_enabled).toBe(1);

    const other = await request.get(`/api/sessions/${b}`).expect(200);
    expect(other.body.computer_tool_enabled ?? null).toBeNull();

    const off = await request
      .put(`/api/sessions/${b}/computer-tool`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.computer_tool_enabled).toBe(0);

    const cleared = await request
      .put(`/api/sessions/${a}/computer-tool`)
      .send({ enabled: null })
      .expect(200);
    expect(cleared.body.computer_tool_enabled).toBeNull();
  });
});
