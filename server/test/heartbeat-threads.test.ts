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
    name: 'Thread Test Agent',
  })) as unknown as Agent;
});

// ═══════════════════════════════════════════════════════════════════
// getThreadBySourceId prepared statement
// ═══════════════════════════════════════════════════════════════════

describe('getThreadBySourceId', () => {
  it('finds a thread by project, type, and source_id', async () => {
    const thread = (await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent.id,
    })) as unknown as ThreadRow;

    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const match = (res.body as ThreadRow[]).find((t) => t.source_id === agent.id);
    expect(match).toBeDefined();
    expect(match!.id).toBe(thread.id);
    expect(match!.name).toBe(`${agent.name} heartbeat`);
    expect(match!.type).toBe('heartbeat');
  });

  it('returns empty when no matching source_id exists', async () => {
    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const match = (res.body as ThreadRow[]).find((t) => t.source_id === 'nonexistent-agent-id');
    expect(match).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// Thread entry creation for heartbeat results
// ═══════════════════════════════════════════════════════════════════

describe('Heartbeat thread entries', () => {
  let heartbeatThread: ThreadRow;

  beforeAll(async () => {
    heartbeatThread = (await createThread(project.id, {
      name: `${agent.name} heartbeat`,
      type: 'heartbeat',
      source_id: `entry-test-${agent.id}`,
    })) as unknown as ThreadRow;
  });

  it('adds a success entry to the thread', async () => {
    const content = 'All systems operational. No issues found.';
    const res = await request
      .post(`/api/threads/${heartbeatThread.id}/entries`)
      .send({ content })
      .expect(201);

    expect(res.body.thread_id).toBe(heartbeatThread.id);
    expect(res.body.content).toBe(content);
    expect(res.body).toHaveProperty('timestamp');
  });

  it('adds an error entry to the thread', async () => {
    const content = 'ERROR: Timed out after 5 minutes';
    const res = await request
      .post(`/api/threads/${heartbeatThread.id}/entries`)
      .send({ content })
      .expect(201);

    expect(res.body.content).toBe(content);
  });

  it('lists entries in chronological order', async () => {
    const res = await request.get(`/api/threads/${heartbeatThread.id}/entries`).expect(200);

    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body[0].content).toBe('All systems operational. No issues found.');
    expect(res.body[1].content).toBe('ERROR: Timed out after 5 minutes');
  });

  it('creates multiple threads for different agents in the same project', async () => {
    const agent2 = (await createAgent({
      projectId: project.id,
      name: 'Second Agent',
    })) as unknown as Agent;
    const thread2 = (await createThread(project.id, {
      name: `${agent2.name} heartbeat`,
      type: 'heartbeat',
      source_id: agent2.id,
    })) as unknown as ThreadRow;

    const res = await request.get(`/api/projects/${project.id}/threads?type=heartbeat`).expect(200);

    const threadIds = (res.body as ThreadRow[]).map((t) => t.id);
    expect(threadIds).toContain(heartbeatThread.id);
    expect(threadIds).toContain(thread2.id);
  });
});
