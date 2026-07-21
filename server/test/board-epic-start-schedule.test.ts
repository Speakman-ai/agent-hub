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

interface EpicRow {
  scheduled_start_cron: string | null;
  scheduled_start_timezone: string | null;
  scheduled_start_enabled: number;
}

describe('Epic scheduled start', () => {
  it('persists a schedule via PUT (retained pause with enabled:false)', async () => {
    const id = await createEpic('Scheduled Start Persist');
    const res = await request
      .put(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .send({ cron: '0 9 * * 1', timezone: 'America/New_York', enabled: false })
      .expect(200);
    const epic = res.body as EpicRow;
    expect(epic.scheduled_start_cron).toBe('0 9 * * 1');
    expect(epic.scheduled_start_timezone).toBe('America/New_York');
    // enabled:false is a retained pause — the config sticks, the switch is off.
    expect(epic.scheduled_start_enabled).toBe(0);
  });

  it('rejects an invalid cron expression', async () => {
    const id = await createEpic('Scheduled Start Bad Cron');
    await request
      .put(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .send({ cron: 'not a cron', enabled: false })
      .expect(400);
  });

  it('rejects an invalid IANA timezone', async () => {
    const id = await createEpic('Scheduled Start Bad TZ');
    await request
      .put(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .send({ cron: '0 9 * * 1', timezone: 'Mars/Phobos', enabled: false })
      .expect(400);
  });

  it('clears the schedule via DELETE', async () => {
    const id = await createEpic('Scheduled Start Clear');
    await request
      .put(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .send({ cron: '30 8 * * *', timezone: null, enabled: false })
      .expect(200);
    const res = await request
      .delete(`/api/projects/${projectId}/board/epics/${id}/start-schedule`)
      .expect(200);
    const epic = res.body as EpicRow;
    expect(epic.scheduled_start_cron).toBeNull();
    expect(epic.scheduled_start_enabled).toBe(0);
  });

  it('404s for an unknown epic', async () => {
    await request
      .put(`/api/projects/${projectId}/board/epics/does-not-exist/start-schedule`)
      .send({ cron: '0 9 * * 1', enabled: false })
      .expect(404);
  });
});

describe('Epic-level start (POST /run)', () => {
  it('returns no_phases for an epic with no phases', async () => {
    const id = await createEpic('Epic Run No Phases');
    const res = await request
      .post(`/api/projects/${projectId}/board/epics/${id}/run`)
      .send({})
      .expect(200);
    expect((res.body as { outcome: string }).outcome).toBe('no_phases');
  });

  it('404s for an unknown epic', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/board/epics/does-not-exist/run`)
      .send({})
      .expect(404);
    expect((res.body as { error: string }).error).toMatch(/Epic not found/);
  });

  it('404s for an unknown project', async () => {
    await request
      .post(`/api/projects/does-not-exist-project/board/epics/whatever/run`)
      .send({})
      .expect(404);
  });
});
