import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('Card templates', () => {
  it('CRUDs templates and includes them on board GET', async () => {
    const create = await request
      .post(`/api/projects/${projectId}/board/card-templates`)
      .send({
        name: 'Bug report',
        title: 'Fix:',
        description: 'Steps to reproduce',
        priority: 'high',
        labels: 'bug',
      })
      .expect(200);

    const id = (create.body as { id: string }).id;
    expect((create.body as { name: string }).name).toBe('Bug report');

    const list = await request.get(`/api/projects/${projectId}/board/card-templates`).expect(200);
    expect(Array.isArray(list.body)).toBe(true);
    expect((list.body as { id: string }[]).some((row) => row.id === id)).toBe(true);

    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    expect(
      ((board.body as { cardTemplates?: { id: string }[] }).cardTemplates || []).some(
        (row) => row.id === id,
      ),
    ).toBe(true);

    const updated = await request
      .put(`/api/projects/${projectId}/board/card-templates/${id}`)
      .send({ title: 'Fix: crash' })
      .expect(200);
    expect((updated.body as { title: string }).title).toBe('Fix: crash');

    await request.delete(`/api/projects/${projectId}/board/card-templates/${id}`).expect(200);

    const after = await request.get(`/api/projects/${projectId}/board/card-templates`).expect(200);
    expect(after.body).toEqual([]);
  });

  it('rejects whitespace-only template names on create', async () => {
    await request
      .post(`/api/projects/${projectId}/board/card-templates`)
      .send({
        name: '   ',
        title: 'Empty name',
        priority: 'medium',
      })
      .expect(400);
  });

  it('rejects whitespace-only template names on update without mutating', async () => {
    const create = await request
      .post(`/api/projects/${projectId}/board/card-templates`)
      .send({
        name: 'Named template',
        title: 'Original title',
        priority: 'medium',
      })
      .expect(200);
    const id = (create.body as { id: string }).id;

    await request
      .put(`/api/projects/${projectId}/board/card-templates/${id}`)
      .send({ name: '   ' })
      .expect(400);

    const list = await request.get(`/api/projects/${projectId}/board/card-templates`).expect(200);
    const template = (list.body as Array<{ id: string; name: string }>).find(
      (row) => row.id === id,
    );
    expect(template?.name).toBe('Named template');
  });

  it('clears template epic references when deleting an epic', async () => {
    const epic = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Template Epic', color: '#6366f1' })
      .expect(200);
    const epicId = (epic.body as { id: string }).id;

    const create = await request
      .post(`/api/projects/${projectId}/board/card-templates`)
      .send({
        name: 'Epic template',
        title: 'Epic card',
        priority: 'medium',
        epicId,
      })
      .expect(200);
    const templateId = (create.body as { id: string }).id;
    expect((create.body as { epicId: string }).epicId).toBe(epicId);

    await request.delete(`/api/projects/${projectId}/board/epics/${epicId}`).expect(200);

    const list = await request.get(`/api/projects/${projectId}/board/card-templates`).expect(200);
    const template = (list.body as Array<{ id: string; epicId: string }>).find(
      (row) => row.id === templateId,
    );
    expect(template?.epicId).toBe('');
  });
});
