import type TestAgent from 'supertest/lib/agent.js';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject, createAgent } from './helpers.js';
import type { Project, Agent } from '../types.js';

let request: TestAgent;
let project: Project;
let agent: Agent;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject()) as unknown as Project;
  agent = (await createAgent({
    projectId: project.id,
    name: 'HB Model Agent',
  })) as unknown as Agent;
});

describe('PUT /api/heartbeats/:agentId — model field persistence', () => {
  it('persists a model id on the heartbeat config', async () => {
    const putRes = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({
        enabled: true,
        interval: '*/30 * * * *',
        prompt: 'check the queue',
        model: 'claude-opus-4-7',
      })
      .expect(200);

    expect(putRes.body.model).toBe('claude-opus-4-7');
    expect(putRes.body.interval).toBe('*/30 * * * *');
    expect(putRes.body.prompt).toBe('check the queue');
    expect(putRes.body.enabled).toBe(true);

    const listRes = await request.get('/api/heartbeats').expect(200);
    type HeartbeatOverview = {
      agentId: string;
      heartbeat: { enabled: boolean; interval: string; prompt: string; model?: string };
    };
    const overview = (listRes.body as HeartbeatOverview[]).find((h) => h.agentId === agent.id);
    expect(overview).toBeDefined();
    expect(overview!.heartbeat.model).toBe('claude-opus-4-7');
  });

  it('preserves model when other fields are updated without a model in the payload', async () => {
    // Establish baseline.
    await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({
        enabled: true,
        interval: '0 */12 * * *',
        prompt: 'baseline',
        model: 'claude-haiku-4-6',
      })
      .expect(200);

    // Omit `model` entirely — server must not clobber the existing override.
    const putRes = await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ prompt: 'updated prompt' })
      .expect(200);

    expect(putRes.body.model).toBe('claude-haiku-4-6');
    expect(putRes.body.prompt).toBe('updated prompt');
    expect(putRes.body.interval).toBe('0 */12 * * *');
  });

  it('clears the override when an empty string is sent explicitly', async () => {
    // Seed.
    await request
      .put(`/api/heartbeats/${agent.id}`)
      .send({ model: 'claude-sonnet-4-6' })
      .expect(200);

    const putRes = await request.put(`/api/heartbeats/${agent.id}`).send({ model: '' }).expect(200);

    expect(putRes.body.model).toBeUndefined();
  });

  it('returns 404 for unknown agent ID', async () => {
    await request
      .put('/api/heartbeats/nonexistent-agent')
      .send({ model: 'claude-opus-4-7' })
      .expect(404);
  });
});
