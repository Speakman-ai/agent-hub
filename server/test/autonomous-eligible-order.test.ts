/**
 * Verifies the ordering contract of `getEligibleAutonomousCards`.
 *
 * The autonomous dispatch loop must drain columns in this exact order:
 *   1. "To Do" top → bottom (position ASC)
 *   2. "Backlog" top → bottom (position ASC)
 *
 * Priority is intentionally NOT a sort key — operators express priority by
 * dragging cards between columns / to the top of a column. Previously the SQL
 * sorted by priority first, which meant a "high" backlog card would jump ahead
 * of a "low" To Do card; that defeated manual ordering.
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
  it('returns To Do cards (position ASC) before Backlog cards (position ASC)', async () => {
    const { projectId, epicId, todoCol, backlogCol } = await setup();

    // `createCard` appends to a column — first insert → position 0, second → 1.
    // Interleave insertions across the two columns to prove the SQL does the
    // sorting rather than just returning insertion/rowid order.
    //
    // Priorities are intentionally inverted vs. desired ordering so that a
    // priority-based sort would fail this test.
    await makeCardInEpic(projectId, epicId, backlogCol, 'backlog-top', 'urgent'); // bk pos 0
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-top', 'low'); // todo pos 0
    await makeCardInEpic(projectId, epicId, backlogCol, 'backlog-bottom', 'high'); // bk pos 1
    await makeCardInEpic(projectId, epicId, todoCol, 'todo-bottom', 'low'); // todo pos 1

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    const titles = rows.map((r) => r.title);

    expect(titles).toEqual(['todo-top', 'todo-bottom', 'backlog-top', 'backlog-bottom']);

    // Sanity: an urgent Backlog card still loses to low-priority To Do cards.
    expect(titles.indexOf('todo-bottom')).toBeLessThan(titles.indexOf('backlog-top'));
  });

  it('ignores priority entirely when both cards are in the same column', async () => {
    const { projectId, epicId, todoCol } = await setup();

    // First inserted → position 0 → should come first even though it's low.
    await makeCardInEpic(projectId, epicId, todoCol, 'first-low', 'low');
    await makeCardInEpic(projectId, epicId, todoCol, 'second-urgent', 'urgent');

    const rows = getStmts().getEligibleAutonomousCards.all(epicId, 999) as KanbanCardRow[];
    expect(rows.map((r) => r.title)).toEqual(['first-low', 'second-urgent']);
  });
});
