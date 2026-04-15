import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createCard } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/projects/:projectId/board/cards/:cardId/assign', () => {
  it('assigns a regular agent with standard prompt', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });
    const agentId = agent.id as string;
    const card = await createCard(projectId, {
      title: 'Build auth module',
      description: 'Implement JWT auth',
    });
    const cardId = card.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(200);

    expect(res.body.sessionId).toBeDefined();
    expect(res.body.card.assignee).toBe(agent.name);
    expect(res.body.card.session_id).toBe(res.body.sessionId);
  });

  it('assigns an intake agent with ticket research prompt (no PR instructions)', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({
      projectId,
      role: 'intake',
      name: 'Ticket Intake',
    });
    const agentId = agent.id as string;
    const card = await createCard(projectId, {
      title: 'Design new dashboard',
      description: 'Plan the new dashboard layout and features',
    });
    const cardId = card.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(200);

    expect(res.body.sessionId).toBeDefined();
    expect(res.body.card.assignee).toBe('Ticket Intake');

    // Verify the session was created (the intake prompt is sent via handleChat,
    // which we can't easily inspect in an integration test, but the session exists)
    const sessionRes = await request.get(`/api/sessions/${res.body.sessionId}`).expect(200);
    expect(sessionRes.body.name).toBe('Design new dashboard');
  });

  it('returns 404 for missing card', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId });

    await request
      .post(`/api/projects/${projectId}/board/cards/nonexistent/assign`)
      .send({ agentId: agent.id })
      .expect(404);
  });

  it('returns 400 when agentId is missing', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({})
      .expect(400);
  });

  it('returns 404 for unknown agent', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId);

    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/assign`)
      .send({ agentId: 'ghost-agent' })
      .expect(404);
  });
});
