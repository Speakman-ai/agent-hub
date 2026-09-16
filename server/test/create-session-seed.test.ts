/**
 * Tests for the optional `seedMessage` on POST /api/agents/:agentId/sessions.
 *
 * The User Module's "Start session with this as context" action (email / todo)
 * creates a fresh session pre-seeded with a context block. The server stores it
 * as the first `role='user'` message so the first-turn history bootstrap feeds
 * it to the CLI on the next turn.
 */

import './setup.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent } from './helpers.js';
import type TestAgent from 'supertest/lib/agent.js';

let request: TestAgent;
let agent: Record<string, unknown>;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ id: 'seed-proj', name: 'Seed Project', cwd: '/tmp' });
  agent = await createAgent({
    projectId: project.id as string,
    id: 'seed-agent',
    name: 'Seed Agent',
  });
});

describe('POST /api/agents/:agentId/sessions seedMessage', () => {
  it('pre-stores the seed as the first user message', async () => {
    const create = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'From email', seedMessage: "Here's an email I'd like to work on with you." })
      .expect(200);
    const sessionId = create.body.id as string;

    const msgs = await request.get(`/api/sessions/${sessionId}/messages`).expect(200);
    expect(msgs.body).toHaveLength(1);
    expect(msgs.body[0].role).toBe('user');
    expect(msgs.body[0].content).toContain("Here's an email");
  });

  it('creates an empty session when no seed is given', async () => {
    const create = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'plain' })
      .expect(200);
    const msgs = await request.get(`/api/sessions/${create.body.id}/messages`).expect(200);
    expect(msgs.body).toHaveLength(0);
  });

  it('ignores a whitespace-only seed', async () => {
    const create = await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'blank seed', seedMessage: '   \n  ' })
      .expect(200);
    const msgs = await request.get(`/api/sessions/${create.body.id}/messages`).expect(200);
    expect(msgs.body).toHaveLength(0);
  });

  it('rejects a seed over the max length', async () => {
    await request
      .post(`/api/agents/${agent.id}/sessions`)
      .send({ name: 'too long', seedMessage: 'a'.repeat(50_001) })
      .expect(400);
  });
});
