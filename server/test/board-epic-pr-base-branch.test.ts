import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

describe('Epic PR base-branch (integration branch default)', () => {
  it('persists pr_base_branch on POST /board/epics', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({
        name: 'Epic A',
        description: '',
        color: '#6366F1',
        prBaseBranch: 'feature/epic-line',
      })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('feature/epic-line');
  });

  it('updates pr_base_branch via PUT /board/epics/:id', async () => {
    const create = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Epic B', description: '', color: '#6366F1' })
      .expect(200);
    const id = (create.body as { id: string }).id;
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Epic B',
        description: '',
        color: '#6366F1',
        autonomous: 0,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
        autonomousMaxIterations: 3,
        prBaseBranch: 'feature/updated',
      })
      .expect(200);
    expect((res.body as { pr_base_branch: unknown }).pr_base_branch).toBe('feature/updated');
  });

  it('rejects invalid pr_base_branch on epic PUT', async () => {
    const create = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Epic C', description: '', color: '#6366F1' })
      .expect(200);
    const id = (create.body as { id: string }).id;
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Epic C',
        autonomous: 0,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
        autonomousMaxIterations: 3,
        prBaseBranch: 'bad branch',
      })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/Invalid pr_base_branch/);
  });
});
