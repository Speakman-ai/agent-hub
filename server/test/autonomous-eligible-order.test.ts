/**
 * Verifies the ordering contract of `getEligibleAutonomousCards`.
 *
 * The autonomous dispatch loop drains cards in this exact order:
 *   1. Column: only "To Do" is eligible (Backlog was dropped in May 2026).
 *   2. Within the column: `priority` (urgent → high → medium → low → unset).
 *   3. Within priority: `position` ASC (visual top of the column).
 *
 * Cards in any other column (In Progress, Review, Done, custom) are skipped —
 * the autonomous loop never picks them up regardless of priority.
 */
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';
import { getStmts } from '../db.js';
import type { KanbanCardRow, KanbanEpicRow } from '../types.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

type BoardBody = {
  board: { id: string };
  columns: Array<{ id: string; name: string }>;
};

async function setup(): Promise<{
  projectId: string;
  epicId: string;
  todoCol: string;
  inProgressCol: string;
}> {
  const project = await createProject();
  const projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const body = boardRes.body as BoardBody;
  const todoCol = body.columns.find((c) => c.name === 'To Do')!.id;
  const inProgressCol = body.columns.find((c) => c.name === 'In Progress')!.id;

  const epicRes = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name: 'Autonomous Epic' })
    .expect(200);
  const epicId = (epicRes.body as KanbanEpicRow).id;

  return { projectId, epicId, todoCol, inProgressCol };
}

async function makeCardInEpic(
  projectId: string,
  epicId: string,
  columnId: string,
  title: string,
  priority = 'medium',
): Promise<KanbanCardRow> {
  const card = (await createCard(projectId, { title, columnId, priority })) as unknown as {
    id: string;
  };
  // Attach to epic via the dedicated route.
  await request
    .post(`/api/projects/${projectId}/board/cards/${card.id}/epic`)
    .send({ epicId })
    .expect(200);
  return { id: card.id, title } as KanbanCardRow;
}

describe('getEligibleAutonomousCards — ordering contract', () => {
  it('only considers cards in the To Do column', async () => {
    const { projectId, epicId, todoCol, inProgressCol } = await setup();

    // Insert urgent cards in non-To Do columns to prove they are not picked up.
    await makeCardInEpic(projectId, epicId, inProgressCol, 'in-progress-urgent', 'urgent');
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-low', 'low');

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    const titles = rows.map((r) => r.title);

    expect(titles).toEqual(['todo-low']);
  });

  it('sorts by priority within the To Do column (urgent → high → medium → low)', async () => {
    const { projectId, epicId, todoCol } = await setup();

    // Insert in scrambled order so we know SQL is doing the sort, not insertion
    // order. `position` runs 0..3 in the order shown.
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-medium', 'medium'); // pos 0
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-urgent', 'urgent'); // pos 1
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-low', 'low'); // pos 2
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-high', 'high'); // pos 3

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    expect(rows.map((r) => r.title)).toEqual([
      'todo-urgent',
      'todo-high',
      'todo-medium',
      'todo-low',
    ]);
  });

  it('uses position as a tiebreaker among equal-priority cards in the same column', async () => {
    const { projectId, epicId, todoCol } = await setup();

    // All four are `high`. Position should decide the order (insertion order).
    await makeCardInEpic(projectId, epicId, todoCol, 'high-first', 'high');
    await makeCardInEpic(projectId, epicId, todoCol, 'high-second', 'high');
    await makeCardInEpic(projectId, epicId, todoCol, 'high-third', 'high');

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    expect(rows.map((r) => r.title)).toEqual(['high-first', 'high-second', 'high-third']);
  });
});
