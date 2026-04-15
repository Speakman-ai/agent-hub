import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createAgent, createThread } from './helpers.js';
import type { Project, Agent, ThreadRow } from '../types.js';

let request: TestAgent;
let project: Project;
let agent: Agent;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject()) as unknown as Project;
  agent = (await createAgent({
    projectId: project.id,
    name: 'HB Thread Route Agent',
  })) as unknown as Agent;
});

describe('GET /api/heartbeats/:agentId/thread', () => {
  it('returns null thread when no thread exists yet', async () => {
    const res = await request.get(`/api/heartbeats/${agent.id}/thread`).expect(200);
    expect(res.body.thread).toBeNull();
    expect(res.body.entries).toEqual([]);
  });

  it('returns the thread and entries when a heartbeat thread exists', async () => {
    const thread = (await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent.id,
    })) as unknown as ThreadRow;

    await request
      .post(`/api/threads/${thread.id}/entries`)
      .send({ content: 'Heartbeat check OK' })
      .expect(201);

    const res = await request.get(`/api/heartbeats/${agent.id}/thread`).expect(200);
    expect(res.body.thread).toBeDefined();
    expect(res.body.thread.id).toBe(thread.id);
    expect(res.body.thread.type).toBe('heartbeat');
    expect(res.body.thread.source_id).toBe(agent.id);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(1);
    expect(res.body.entries[0].content).toBe('Heartbeat check OK');
  });

  it('returns 404 for unknown agent ID', async () => {
    await request.get('/api/heartbeats/nonexistent-agent/thread').expect(404);
  });
});
