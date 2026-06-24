/**
 * Regression: new autonomous epics and phases default to dispatching ONE
 * ticket at a time (`autonomous_max_concurrent = 1`).
 *
 * The default was 2; it was lowered to 1 so autonomous / Run-phase dispatch is
 * conservative by default. The create statements set the value explicitly (not
 * just via the column DEFAULT) so DBs created before the change also start new
 * epics/phases at 1.
 */
import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import type { KanbanEpicRow, KanbanPhaseRow } from '../types.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('autonomous default concurrency', () => {
  it('defaults a new epic to 1 ticket at once', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Default Concurrency Epic' })
      .expect(200);
    const epic = epicRes.body as KanbanEpicRow;

    expect(epic.autonomous_max_concurrent).toBe(1);
  });

  it('defaults a new phase to 1 ticket at once', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Phase Default Epic' })
      .expect(200);
    const epicId = (epicRes.body as KanbanEpicRow).id;

    const phaseRes = await request
      .post(`/api/projects/${projectId}/board/phases`)
      .send({ epicId, name: 'Build' })
      .expect(200);
    const phase = phaseRes.body as KanbanPhaseRow;

    expect(phase.autonomous_max_concurrent).toBe(1);
  });
});
