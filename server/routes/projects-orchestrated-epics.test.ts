/**
 * Project.orchestratedEpics: PATCH validation, and the board's manager fields
 * following the setting.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import { presentEpicManagerFields } from '../project-orchestrated-epics.js';

const autonomous = vi.hoisted(() => ({ changed: vi.fn() }));
vi.mock('../autonomous.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../autonomous.js')>();
  return { ...real, noteOrchestratedEpicsChanged: autonomous.changed };
});

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

describe('orchestratedEpics setting', () => {
  it('is off by default, can be turned on and cleared, and reports each flip', async () => {
    const projectId = (await createProject()).id as string;
    const initial = await request.get(`/api/projects/${projectId}`).expect(200);
    expect(initial.body.orchestratedEpics).toBeUndefined();

    autonomous.changed.mockClear();
    const on = await request
      .patch(`/api/projects/${projectId}`)
      .send({ orchestratedEpics: true })
      .expect(200);
    expect(on.body.orchestratedEpics).toBe(true);
    expect(autonomous.changed).toHaveBeenCalledWith(projectId);

    autonomous.changed.mockClear();
    await request.patch(`/api/projects/${projectId}`).send({ name: 'Renamed' }).expect(200);
    expect(autonomous.changed).not.toHaveBeenCalled();

    const cleared = await request
      .patch(`/api/projects/${projectId}`)
      .send({ orchestratedEpics: null })
      .expect(200);
    expect(cleared.body.orchestratedEpics).toBeUndefined();
    expect(autonomous.changed).toHaveBeenCalledWith(projectId);
  });

  it('rejects a non-boolean without half-applying the PATCH', async () => {
    const projectId = (await createProject()).id as string;
    for (const bad of ['yes', 1, {}]) {
      await request
        .patch(`/api/projects/${projectId}`)
        .send({ orchestratedEpics: bad })
        .expect(400);
    }
    // A later field failing leaves an earlier valid orchestratedEpics unapplied.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ orchestratedEpics: true, deleteBranchOnMerge: 'nope' })
      .expect(400);
    const after = await request.get(`/api/projects/${projectId}`).expect(200);
    expect(after.body.orchestratedEpics).toBeUndefined();
  });
});

describe('presentEpicManagerFields', () => {
  const epics = [
    { id: 'e1', manager_agent_id: 'lead-1', manager_state: 'orchestrating' },
    { id: 'e2', manager_agent_id: null, manager_state: 'none' },
  ];

  it('reports no manager on a project with the setting off', () => {
    expect(presentEpicManagerFields({}, epics)).toEqual([
      { id: 'e1', manager_agent_id: null, manager_state: 'none' },
      { id: 'e2', manager_agent_id: null, manager_state: 'none' },
    ]);
  });

  it('passes the manager through when the setting is on', () => {
    expect(presentEpicManagerFields({ orchestratedEpics: true }, epics)).toBe(epics);
  });
});
