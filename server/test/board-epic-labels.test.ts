import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('Epic labels', () => {
  it('persists labels on POST /board/epics', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: 'Labeled epic',
        description: '',
        color: '#6366F1',
        labels: 'platform, q1',
      })
      .expect(200);
    expect((res.body as { labels: unknown }).labels).toBe('platform, q1');
  });

  it('updates labels via PUT /board/epics/:id', async () => {
    const create = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Relabel me', description: '', color: '#6366F1' })
      .expect(200);
    const id = (create.body as { id: string }).id;
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Relabel me',
        description: '',
        color: '#6366F1',
        labels: 'infra',
      })
      .expect(200);
    expect((res.body as { labels: unknown }).labels).toBe('infra');
  });
});
