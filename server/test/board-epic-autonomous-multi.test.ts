import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';
import { getDb } from '../db.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

async function createEpic(name: string, targetProjectId = projectId): Promise<string> {
  const res = await request
    .post(`/api/projects/${targetProjectId}/board/epics`)
    .send({ name, description: '', color: '#6366F1' })
    .expect(200);
  return (res.body as { id: string }).id;
}

async function enableAutonomous(id: string, name: string): Promise<void> {
  await request
    .put(`/api/projects/${projectId}/board/epics/${id}`)
    .send({ name, autonomous: 1, autonomousInterval: 5, autonomousMaxConcurrent: 2 })
    .expect(200);
}

function epicAutonomousFlag(
  board: { epics: Array<{ id: string; autonomous?: number }> },
  id: string,
): number | undefined {
  return board.epics.find((e) => e.id === id)?.autonomous;
}

describe('Multiple epics in autonomous mode at once', () => {
  it('enabling autonomous on a second epic does NOT disable the first', async () => {
    const epicA = await createEpic('Multi Epic A');
    const epicB = await createEpic('Multi Epic B');

    await enableAutonomous(epicA, 'Multi Epic A');
    let board = (await request.get(`/api/projects/${projectId}/board`).expect(200)).body as {
      epics: Array<{ id: string; autonomous?: number }>;
    };
    expect(epicAutonomousFlag(board, epicA)).toBe(1);

    // Turning on B must leave A autonomous — the board runs both at once.
    await enableAutonomous(epicB, 'Multi Epic B');
    board = (await request.get(`/api/projects/${projectId}/board`).expect(200)).body as {
      epics: Array<{ id: string; autonomous?: number }>;
    };
    expect(epicAutonomousFlag(board, epicA)).toBe(1);
    expect(epicAutonomousFlag(board, epicB)).toBe(1);
  });

  it('autonomous/status reports every active epic in the epics[] array', async () => {
    const epicA = await createEpic('Status Epic A');
    const epicB = await createEpic('Status Epic B');
    await enableAutonomous(epicA, 'Status Epic A');
    await enableAutonomous(epicB, 'Status Epic B');

    const res = await request.get(`/api/projects/${projectId}/board/autonomous/status`).expect(200);
    const body = res.body as {
      active: boolean;
      epics: Array<{ epicId: string; epicName: string }>;
    };
    expect(body.active).toBe(true);
    const ids = body.epics.map((e) => e.epicId);
    expect(ids).toContain(epicA);
    expect(ids).toContain(epicB);
  });

  it('autonomous/status reports running phases when no epic-level autonomous epic is active', async () => {
    const phaseOnlyProject = await createProject();
    const phaseOnlyProjectId = phaseOnlyProject.id as string;
    const epicId = await createEpic('Status Phase Epic', phaseOnlyProjectId);
    const phaseRes = await request
      .post(`/api/projects/${phaseOnlyProjectId}/board/phases`)
      .send({ epicId, name: 'Status Phase', description: '' })
      .expect(200);
    const phaseId = (phaseRes.body as { id: string }).id;
    getDb().prepare('UPDATE kanban_phases SET autonomous_running = 1 WHERE id = ?').run(phaseId);

    const res = await request
      .get(`/api/projects/${phaseOnlyProjectId}/board/autonomous/status`)
      .expect(200);
    const body = res.body as {
      active: boolean;
      epics: Array<{ epicId: string }>;
      phases: Array<{ phaseId: string; phaseName: string; epicId: string; epicName: string }>;
    };
    expect(body.active).toBe(true);
    expect(body.epics).toEqual([]);
    expect(body.phases).toContainEqual(
      expect.objectContaining({
        phaseId,
        phaseName: 'Status Phase',
        epicId,
        epicName: 'Status Phase Epic',
      }),
    );
  });
});
