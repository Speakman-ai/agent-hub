import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('card session_id holds exactly one session', () => {
  it('collapses a doubled X-Agent-Hub-Session-Id on create', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (board.body.columns as Array<{ id: string }>)[0].id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set('X-Agent-Hub-Session-Id', 'sess-dup, sess-dup')
      .send({ title: 'Doubled header', columnId })
      .expect(200);
    expect(res.body.session_id).toBe('sess-dup');
  });

  it('collapses a doubled sessionId on update and rejects a list', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const card = await createCard(projectId, { title: 'Update link' });
    const cardId = card.id as string;

    const ok = await request
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ sessionId: 'sess-a, sess-a' })
      .expect(200);
    expect(ok.body.session_id).toBe('sess-a');

    await request
      .put(`/api/projects/${projectId}/board/cards/${cardId}`)
      .send({ sessionId: 'sess-a, sess-b' })
      .expect(400);
  });

  it('rejects conflicting ids on create, in the body or the header, without writing a card', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (board.body.columns as Array<{ id: string }>)[0].id;

    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Conflicting body', columnId, sessionId: 's1, s2' })
      .expect(400);
    await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set('X-Agent-Hub-Session-Id', 's1, s2')
      .send({ title: 'Conflicting header', columnId })
      .expect(400);

    const cards = await request.get(`/api/projects/${projectId}/board/cards`).expect(200);
    const titles = (cards.body as Array<{ title: string }>).map((c) => c.title);
    expect(titles).not.toContain('Conflicting body');
    expect(titles).not.toContain('Conflicting header');
  });

  it('an explicit body sessionId wins over a conflicting header', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (board.body.columns as Array<{ id: string }>)[0].id;

    const res = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .set('X-Agent-Hub-Session-Id', 's1, s2')
      .send({ title: 'Body wins', columnId, sessionId: null })
      .expect(200);
    expect(res.body.session_id).toBeNull();
  });
});
