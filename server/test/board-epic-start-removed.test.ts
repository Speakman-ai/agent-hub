import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

// Regression guard for the removal of the epic-level "Autonomous start" panel.
// The epic-level start sweep (POST .../run) and the scheduled-start cron
// (PUT/DELETE .../start-schedule) were removed in favor of per-phase start.
// These endpoints must no longer be mounted, even for a real, existing epic —
// a bare 404 on a random path proves nothing, so each case creates a valid epic
// first and asserts the route itself is gone.
let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

async function createEpic(name: string): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name, description: '', color: '#6366F1' })
    .expect(200);
  return (res.body as { id: string }).id;
}

describe('Epic-level Autonomous start removed', () => {
  it('POST /board/epics/:id/run is no longer mounted', async () => {
    const id = await createEpic('Epic Run');
    await request.post(`/api/projects/${projectId}/board/epics/${id}/run`).send({}).expect(404);
  });

  it('PUT /board/epics/:id/start-schedule is no longer mounted', async () => {
    const id = await createEpic('Epic Sched');
    await request
      .put(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .send({ cron: '0 9 * * 1', timezone: 'America/Chicago', enabled: true })
      .expect(404);
  });

  it('DELETE /board/epics/:id/start-schedule is no longer mounted', async () => {
    const id = await createEpic('Epic Clear');
    await request.delete(`/api/projects/${projectId}/board/epics/${id}/start-schedule`).expect(404);
  });
});
