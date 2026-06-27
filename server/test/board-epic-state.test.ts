import type supertest from 'supertest';
import { getDb } from '../db.js';
import { getRequest, createProject, createCard } from './helpers.js';

let request: supertest.Agent;
let projectId: string;
let todoColumnId: string;
let inProgressColumnId: string;
let doneColumnId: string;

async function getEpicState(epicId: string): Promise<string | null> {
  const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const epic = (board.body.epics as Array<{ id: string; state: string | null }>).find(
    (row) => row.id === epicId,
  );
  if (!epic) throw new Error(`Epic ${epicId} not found`);
  return epic.state;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const columns = board.body.columns as Array<{ id: string; name: string }>;
  todoColumnId = columns.find((column) => column.name === 'To Do')?.id as string;
  inProgressColumnId = columns.find((column) => column.name === 'In Progress')?.id as string;
  doneColumnId = columns.find((column) => column.name === 'Done')?.id as string;
});

describe('Epic lifecycle state', () => {
  it('tracks not started, in progress, and done from linked card columns', async () => {
    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Lifecycle epic', color: '#6366F1' })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;
    expect(await getEpicState(epicId)).toBeNull();

    const first = await createCard(projectId, {
      title: 'First ticket',
      columnId: todoColumnId,
      epicId,
    });
    expect(await getEpicState(epicId)).toBe('not_started');

    getDb()
      .prepare("UPDATE kanban_epics SET state = 'done', updated_at = ? WHERE id = ?")
      .run('2000-01-01 00:00:00', epicId);
    const boardWithComputedState = await request
      .get(`/api/projects/${projectId}/board`)
      .expect(200);
    const computedEpic = (
      boardWithComputedState.body.epics as Array<{ id: string; state: string | null }>
    ).find((row) => row.id === epicId);
    expect(computedEpic?.state).toBe('not_started');
    const persistedEpic = getDb()
      .prepare('SELECT state, updated_at FROM kanban_epics WHERE id = ?')
      .get(epicId) as { state: string | null; updated_at: string };
    expect(persistedEpic).toEqual({ state: 'done', updated_at: '2000-01-01 00:00:00' });

    await request
      .post(`/api/projects/${projectId}/board/cards/${first.id}/move`)
      .send({ columnId: inProgressColumnId })
      .expect(200);
    expect(await getEpicState(epicId)).toBe('in_progress');

    const second = await createCard(projectId, {
      title: 'Second ticket',
      columnId: todoColumnId,
      epicId,
    });
    expect(await getEpicState(epicId)).toBe('in_progress');

    for (const card of [first, second]) {
      await request
        .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
        .send({ columnId: doneColumnId })
        .expect(200);
    }
    expect(await getEpicState(epicId)).toBe('done');

    await request
      .post(`/api/projects/${projectId}/board/cards/${second.id}/move`)
      .send({ columnId: todoColumnId })
      .expect(200);
    expect(await getEpicState(epicId)).toBe('in_progress');
  });
});
