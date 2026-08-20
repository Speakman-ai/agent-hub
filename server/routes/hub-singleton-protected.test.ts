import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { getRequest } from '../test/helpers.js';
import { HUB_ASSISTANT_AGENT_ID, HUB_PROJECT_ID } from '../../shared/utils/hub.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
  // Seed the hidden Hub project + assistant agent so findAgent/findProject
  // resolve them — without this the routes 404 on "missing" rather than
  // exercising the protection guard.
  const { ensureHubAssistantAgent } = await import('../hub-assistant.js');
  ensureHubAssistantAgent();
}, 60_000);

describe('Hub singleton is protected from mutation/delete', () => {
  it('rejects DELETE of the Hub assistant agent with 403', async () => {
    const res = await request.delete(`/api/agents/${HUB_ASSISTANT_AGENT_ID}`).expect(403);
    expect(res.body.code).toBe('hub_agent_protected');
  });

  it('rejects PATCH (engine/role) of the Hub assistant agent with 403', async () => {
    const res = await request
      .patch(`/api/agents/${HUB_ASSISTANT_AGENT_ID}`)
      .send({ engine: 'cursor-agent', role: 'dev' })
      .expect(403);
    expect(res.body.code).toBe('hub_agent_protected');

    // The shared row is untouched: engine/role were not rewritten.
    const { findAgent } = await import('../project-model.js');
    const found = findAgent(HUB_ASSISTANT_AGENT_ID);
    expect(found?.agent.engine).toBe('claude-code');
    expect(found?.agent.role).toBe('hub-assistant');
  });

  it('rejects DELETE of the Hub system project with 403', async () => {
    const res = await request.delete(`/api/projects/${HUB_PROJECT_ID}`).expect(403);
    expect(res.body.code).toBe('hub_project_protected');
  });

  it('rejects PATCH of the Hub system project with 403', async () => {
    const res = await request
      .patch(`/api/projects/${HUB_PROJECT_ID}`)
      .send({ name: 'Renamed Hub' })
      .expect(403);
    expect(res.body.code).toBe('hub_project_protected');
  });
});
