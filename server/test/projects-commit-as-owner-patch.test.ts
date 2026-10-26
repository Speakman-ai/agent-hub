import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — commitAsOwner', () => {
  it('persists commitAsOwner.enabled and reads it back', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ commitAsOwner: { enabled: true } })
      .expect(200);
    const read = await request.get(`/api/projects/${projectId}`).expect(200);
    expect((read.body as { commitAsOwner?: unknown }).commitAsOwner).toEqual({ enabled: true });
  });

  it('clears the setting with null', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ commitAsOwner: { enabled: true } })
      .expect(200);
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ commitAsOwner: null })
      .expect(200);
    expect((res.body as { commitAsOwner?: unknown }).commitAsOwner).toBeUndefined();
  });

  it('rejects a non-boolean enabled without mutating the project', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const res = await request
      .patch(`/api/projects/${projectId}`)
      .send({ commitAsOwner: { enabled: 'yes' } })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(
      /commitAsOwner.enabled must be a boolean/,
    );
    const read = await request.get(`/api/projects/${projectId}`).expect(200);
    expect((read.body as { commitAsOwner?: unknown }).commitAsOwner).toBeUndefined();
  });

  it('rejects a non-object value', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ commitAsOwner: true })
      .expect(400);
    expect((res.body as { error: string }).error).toMatch(/commitAsOwner must be an object/);
  });
});
