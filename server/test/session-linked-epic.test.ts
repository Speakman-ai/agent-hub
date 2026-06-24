/**
 * Tests for `PUT /api/sessions/:sessionId/linked-epic`.
 *
 * The linked epic drives scoping-mode prompt assembly, which loads the
 * epic/spec data straight from `sessions.linked_epic_id`. The endpoint must
 * therefore refuse to link an epic that belongs to a *different* project than
 * the session — otherwise a user could pull a foreign project's scoping
 * context into their own session.
 */
import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createSession } from './helpers.js';

let request: supertest.Agent;

interface SessionBody {
  id: string;
  agent_id?: string;
  linked_epic_id?: string | null;
}

async function createEpic(projectId: string, name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name })
    .expect(200);
  return (res.body as { id: string }).id;
}

beforeAll(async () => {
  request = await getRequest();
});

describe('PUT /api/sessions/:sessionId/linked-epic', () => {
  it('links an epic from the session’s own project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const session = (await createSession({
      agentId: agent.id as string,
    })) as unknown as SessionBody;
    const epicId = await createEpic(projectId, 'Own epic');

    const res = await request
      .put(`/api/sessions/${session.id}/linked-epic`)
      .send({ epicId })
      .expect(200);
    expect((res.body as SessionBody).linked_epic_id).toBe(epicId);
  });

  it('refuses to link an epic that belongs to a different project', async () => {
    const projectA = await createProject();
    const agent = await createAgent({ projectId: projectA.id as string });
    const session = (await createSession({
      agentId: agent.id as string,
    })) as unknown as SessionBody;

    // Epic created under a *different* project's board.
    const projectB = await createProject();
    const foreignEpic = await createEpic(projectB.id as string, 'Foreign epic');

    await request
      .put(`/api/sessions/${session.id}/linked-epic`)
      .send({ epicId: foreignEpic })
      .expect(404);

    // The session was not mutated.
    const detail = await request.get(`/api/sessions/${session.id}`).expect(200);
    expect((detail.body as SessionBody).linked_epic_id ?? null).toBeNull();
  });

  it('unlinks when epicId is null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const session = (await createSession({
      agentId: agent.id as string,
    })) as unknown as SessionBody;
    const epicId = await createEpic(projectId, 'To unlink');

    await request.put(`/api/sessions/${session.id}/linked-epic`).send({ epicId }).expect(200);
    const cleared = await request
      .put(`/api/sessions/${session.id}/linked-epic`)
      .send({ epicId: null })
      .expect(200);
    expect((cleared.body as SessionBody).linked_epic_id ?? null).toBeNull();
  });
});
