/**
 * Verifies the ordering contract of `getEligibleAutonomousCards`.
 *
 * The autonomous dispatch loop drains cards in this exact order:
 *   1. Column: "To Do" before "Backlog".
 *   2. Within a column: `priority` (urgent → high → medium → low → unset).
 *   3. Within a column + priority: `position` ASC (visual top of the column).
 *
 * Column ordering is the operator's coarsest signal: an urgent Backlog card
 * never jumps ahead of a low-priority To Do card. Within a single column,
 * higher-priority work drains first; `position` is only the tiebreaker.
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
  backlogCol: string;
}> {
  const project = await createProject();
  const projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const body = boardRes.body as BoardBody;
  const todoCol = body.columns.find((c) => c.name === 'To Do')!.id;
  const backlogCol = body.columns.find((c) => c.name === 'Backlog')!.id;

  const epicRes = await request
    .post(`/api/projects/${projectId}/board/epics`)
    .send({ name: 'Autonomous Epic' })
    .expect(200);
  const epicId = (epicRes.body as KanbanEpicRow).id;

  return { projectId, epicId, todoCol, backlogCol };
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
  it('drains all To Do cards before any Backlog cards, regardless of priority', async () => {
    const { projectId, epicId, todoCol, backlogCol } = await setup();

    // Interleave insertions across the two columns to prove the SQL — not
    // insertion order — does the sorting. Backlog cards are deliberately
    // higher-priority than the To Do cards to prove the column gate wins.
    await makeCardInEpic(projectId, epicId, backlogCol, 'backlog-urgent', 'urgent');
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-low-1', 'low');
    await makeCardInEpic(projectId, epicId, backlogCol, 'backlog-high', 'high');
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-low-2', 'low');

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    const titles = rows.map((r) => r.title);

    // Both To Do cards come first (column gate), then both Backlog cards
    // (sorted urgent → high within Backlog).
    expect(titles).toEqual(['todo-low-1', 'todo-low-2', 'backlog-urgent', 'backlog-high']);
    expect(titles.indexOf('todo-low-2')).toBeLessThan(titles.indexOf('backlog-urgent'));
  });

  it('sorts by priority within a single column (urgent → high → medium → low)', async () => {
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
