/**
 * A worker switched into Orchestrate lists its own workers on its rail and
 * links back up to the chat that started it. The worker it spawns must not
 * vanish from every list.
 */
import './setup.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type TestAgent from 'supertest/lib/agent.js';
import { createAgent, createProject, createSession, getRequest } from './helpers.js';

let request: TestAgent;
let agentId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ id: 'orch-nested', name: 'Nested', cwd: '/tmp' });
  const agent = await createAgent({ projectId: project.id as string, id: 'orch-nested-dev' });
  agentId = agent.id as string;
});

describe('Orchestrate worker switched into Orchestrate', () => {
  it('shows its own workers and links up to its parent', async () => {
    const { stmts } = await import('../db.js');
    const parent = await createSession({ agentId, name: 'Top chat' });
    const worker = await createSession({ agentId, name: 'Worker' });
    stmts!.updateSessionMode.run('orchestrate', parent.id as string);
    stmts!.markSessionSpawnedFrom.run(parent.id as string, worker.id as string);

    await request
      .patch(`/api/sessions/${worker.id}`)
      .send({ session_mode: 'orchestrate' })
      .expect(200);
    const grandchild = await createSession({ agentId, name: 'Grandchild' });
    stmts!.markSessionSpawnedFrom.run(worker.id as string, grandchild.id as string);

    const own = await request.get(`/api/sessions/${worker.id}/spawned`).expect(200);
    expect(own.body.sessions.map((row: { id: string }) => row.id)).toEqual([grandchild.id]);
    expect(own.body.parent.up).toEqual({ id: parent.id, name: 'Top chat', agent_id: agentId });

    const top = await request.get(`/api/sessions/${parent.id}/spawned`).expect(200);
    expect(top.body.sessions.map((row: { id: string }) => row.id)).toEqual([worker.id]);
    expect(top.body.parent.up).toBeNull();

    // Leaving Orchestrate hands the grandchild back to the normal list.
    await request.patch(`/api/sessions/${worker.id}`).send({ session_mode: 'chat' }).expect(200);
    const listed = await request.get(`/api/agents/${agentId}/sessions`).expect(200);
    expect(listed.body.map((row: { id: string }) => row.id)).toContain(grandchild.id);
  });
});
