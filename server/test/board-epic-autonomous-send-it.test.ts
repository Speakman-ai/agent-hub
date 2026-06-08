import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

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

describe('Epic autonomous Send It flag', () => {
  it('defaults autonomous_send_it to 0 for a freshly created epic', async () => {
    const id = await createEpic('Send It Default');
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const epic = (
      res.body as { epics: Array<{ id: string; autonomous_send_it?: number }> }
    ).epics.find((e) => e.id === id);
    expect(epic?.autonomous_send_it).toBe(0);
  });

  it('persists autonomousSendIt via PUT /board/epics/:id', async () => {
    const id = await createEpic('Send It On');
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Send It On',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
        autonomousSendIt: 1,
      })
      .expect(200);
    expect((res.body as { autonomous_send_it: unknown }).autonomous_send_it).toBe(1);

    // And it can be cleared back to 0.
    const cleared = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Send It On',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
        autonomousSendIt: 0,
      })
      .expect(200);
    expect((cleared.body as { autonomous_send_it: unknown }).autonomous_send_it).toBe(0);
  });

  it('preserves the stored autonomous_send_it when the PUT omits the field', async () => {
    const id = await createEpic('Send It Preserve');
    await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Send It Preserve',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
        autonomousSendIt: 1,
      })
      .expect(200);
    // A subsequent PUT that does not carry autonomousSendIt must not reset it.
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}`)
      .send({
        name: 'Send It Preserve (renamed)',
        autonomous: 1,
        autonomousInterval: 5,
        autonomousMaxConcurrent: 2,
      })
      .expect(200);
    expect((res.body as { autonomous_send_it: unknown }).autonomous_send_it).toBe(1);
  });

  it('rejects out-of-range autonomousSendIt values (only 0 | 1 allowed)', async () => {
    const id = await createEpic('Send It Range');
    for (const bad of [2, -1]) {
      await request
        .put(`/api/projects/${projectId}/board/epics/${id}`)
        .send({
          name: 'Send It Range',
          autonomous: 1,
          autonomousInterval: 5,
          autonomousMaxConcurrent: 2,
          autonomousSendIt: bad,
        })
        .expect(400);
    }
    // The rejected requests must not have flipped the stored flag on.
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const epic = (
      board.body as { epics: Array<{ id: string; autonomous_send_it?: number }> }
    ).epics.find((e) => e.id === id);
    expect(epic?.autonomous_send_it).toBe(0);
  });
});
