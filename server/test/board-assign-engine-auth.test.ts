import type supertest from 'supertest';
import { getRequest, createProject, createAgent, createCard } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /assign without an acting user', () => {
  it('refuses a per-account engine before creating a session or touching the card', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const agent = await createAgent({ projectId, engine: 'cursor-agent' });
    const agentId = agent.id as string;
    const card = await createCard(projectId, { title: 'Ownerless assign' });
    const cardId = card.id as string;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${cardId}/assign`)
      .send({ agentId })
      .expect(409);
    expect(res.body.code).toBe('no_account_credentials');
    expect(res.body.error).toMatch(/no acting user/);

    const cardsRes = await request.get(`/api/projects/${projectId}/board/cards`).expect(200);
    const after = (
      cardsRes.body as Array<{
        id: string;
        column_id: string;
        session_id: string | null;
        assignee: string | null;
      }>
    ).find((c) => c.id === cardId);
    expect(after?.column_id).toBe(card.column_id);
    expect(after?.session_id).toBeFalsy();
    expect(after?.assignee).toBeFalsy();

    const sessions = getDb()
      .prepare('SELECT COUNT(*) AS n FROM sessions WHERE agent_id = ?')
      .get(agentId) as { n: number };
    expect(sessions.n).toBe(0);
  });
});
