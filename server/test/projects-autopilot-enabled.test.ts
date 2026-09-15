import { beforeAll, expect, it } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
beforeAll(async () => {
  request = await getRequest();
});

it('projects expose the same enabled flag as Autopilot configuration', async () => {
  const project = await createProject();
  const detail = () => request.get(`/api/projects/${project.id}`).expect(200);
  expect((await detail()).body.autopilotEnabled).toBe(false);
  await request
    .put(`/api/projects/${project.id}/autopilot/config`)
    .send({ enabled: true })
    .expect(200);
  expect((await detail()).body.autopilotEnabled).toBe(true);
  const list = await request.get('/api/projects').expect(200);
  expect(list.body.find((p: { id: string }) => p.id === project.id).autopilotEnabled).toBe(true);
  await request.post(`/api/projects/${project.id}/autopilot/disable`).expect(200);
  expect((await detail()).body.autopilotEnabled).toBe(false);
});
