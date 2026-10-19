import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// PATCH /api/projects/:projectId — finalizeRunner.spot (Spot vs on-demand CI
// capacity) and GET .../ci-runs/runner-options.

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('PATCH /api/projects/:projectId — finalizeRunner', () => {
  it('persists spot=false and reports it on runner-options', async () => {
    const project = await createProject();
    const id = project.id as string;
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ finalizeRunner: { spot: false } })
      .expect(200);
    expect(res.body.finalizeRunner).toEqual({ spot: false });

    const opts = await request.get(`/api/projects/${id}/ci-runs/runner-options`).expect(200);
    expect(opts.body).toEqual({ spotChoiceAvailable: false, spot: false });
  });

  it('defaults to Spot when unset', async () => {
    const project = await createProject();
    const opts = await request
      .get(`/api/projects/${project.id as string}/ci-runs/runner-options`)
      .expect(200);
    expect(opts.body.spot).toBe(true);
  });

  it('clears the setting when null is sent', async () => {
    const project = await createProject();
    const id = project.id as string;
    await request.patch(`/api/projects/${id}`).send({ finalizeRunner: { spot: false } });
    const res = await request
      .patch(`/api/projects/${id}`)
      .send({ finalizeRunner: null })
      .expect(200);
    expect(res.body.finalizeRunner).toBeUndefined();
  });

  it('rejects a non-boolean spot with 400', async () => {
    const project = await createProject();
    const res = await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ finalizeRunner: { spot: 'no' } })
      .expect(400);
    expect(res.body.error).toMatch(/finalizeRunner.spot must be a boolean/);
  });

  it('rejects a non-object value with 400', async () => {
    const project = await createProject();
    await request
      .patch(`/api/projects/${project.id as string}`)
      .send({ finalizeRunner: true })
      .expect(400);
  });
});
