import { afterEach, describe, expect, it, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';
import { getStmts } from '../db.js';

// The first test boots the Express app (cold) which can exceed the 5s default
// under full-suite load; give this file's tests headroom.
vi.setConfig({ testTimeout: 30000 });

// Workload regression for the paginated-board performance criterion. The read
// path must do NO work proportional to card count: not the full-board row load,
// not a DISTINCT label scan, not a per-column COUNT. Epic state is read from the
// persisted kanban_epics.state, labels from the trigger-invalidated board facet
// cache, and column totals from the trigger-maintained kanban_columns.card_count.
// So we spy on every card-scanning statement and assert a clean-board paginated
// read calls none of them.

let request: supertest.Agent;

async function setup() {
  request = await getRequest();
  const project = await createProject();
  const projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const columns = (boardRes.body as { columns: Array<{ id: string; name: string }> }).columns;
  const columnId = columns[0]!.id;
  const doneId = columns.find((c) => c.name.toLowerCase() === 'done')?.id ?? columns.at(-1)!.id;
  return { projectId, columnId, doneId };
}

function spyCardScans() {
  const stmts = getStmts();
  return {
    fullBoard: vi.spyOn(stmts.getKanbanCards, 'all'),
    labelScan: vi.spyOn(stmts.getDistinctCardLabelsByBoard, 'all'),
    columnCount: vi.spyOn(stmts.countKanbanCardsByColumn, 'get'),
    blockerBoard: vi.spyOn(stmts.getBlockersForBoard, 'all'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /board?limit — bounded by board structure, not card count', () => {
  it('a clean-board paginated read calls no card-scanning statement', async () => {
    const { projectId, columnId } = await setup();
    await createCard(projectId, { columnId, title: 'Card A limit', labels: 'alpha' });
    await createCard(projectId, { columnId, title: 'Card B limit', labels: 'beta' });
    await createCard(projectId, { columnId, title: 'Card C limit', labels: 'gamma' });

    // Prime the label facet cache (clears the trigger dirty flag).
    await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);

    const spies = spyCardScans();
    const res = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    const body = res.body as {
      cards: Array<{ column_id: string }>;
      cursors?: Record<string, string | null>;
      counts: Record<string, number>;
      availableLabels: string[];
    };

    // No card-count-proportional work on the read path.
    expect(spies.fullBoard).not.toHaveBeenCalled();
    expect(spies.labelScan).not.toHaveBeenCalled();
    expect(spies.columnCount).not.toHaveBeenCalled();
    expect(spies.blockerBoard).not.toHaveBeenCalled();

    // ...while still returning correct, board-wide facets.
    expect(res.body).toBeTruthy();
    expect(body.cursors?.[columnId]).toBeTruthy();
    expect(body.cards.filter((c) => c.column_id === columnId).length).toBeLessThanOrEqual(1);
    expect(body.counts[columnId]).toBe(3);
    expect(body.availableLabels).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
  });

  it('scopes card serialization lookups to the page, not the whole board', async () => {
    const { projectId, columnId } = await setup();
    // Many cards in one column; only one comes back per ?limit=1 page.
    for (let i = 0; i < 6; i++) {
      await createCard(projectId, { columnId, title: `Serialize card ${i}` });
    }

    const stmts = getStmts();
    // The board-wide support-ticket UNION and board-wide finalize-run scan were
    // the remaining O(board size) work in single-card / page serialization; they
    // are removed in favor of card-id / session-id scoped lookups.
    const stmtsRec = stmts as unknown as Record<string, unknown>;
    expect(stmtsRec.getLinkedSupportTicketsForBoard).toBeUndefined();
    expect(stmtsRec.listLatestFinalizeRunsForBoard).toBeUndefined();

    const ticketSpy = vi.spyOn(stmts.getLinkedSupportTicketsForCardIds, 'all');
    const blockerScopedSpy = vi.spyOn(stmts.getBlockersForCardIds, 'all');
    const blockerBoardSpy = vi.spyOn(stmts.getBlockersForBoard, 'all');
    const res = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    const body = res.body as { cards: Array<{ id: string; column_id: string }> };

    const returnedIds = body.cards.map((c) => c.id);

    // The linked-ticket lookup ran with exactly the returned page's card ids —
    // bounded by page size (1 here), not the 6 cards on the board.
    expect(ticketSpy).toHaveBeenCalledTimes(1);
    const ticketIds = JSON.parse(ticketSpy.mock.calls[0]![0] as string) as string[];
    expect(ticketIds.sort()).toEqual([...returnedIds].sort());

    // Blocker enrichment is scoped to the page ids too — never the board-wide load.
    expect(blockerBoardSpy).not.toHaveBeenCalled();
    expect(blockerScopedSpy).toHaveBeenCalledTimes(1);
    const blockerIds = JSON.parse(blockerScopedSpy.mock.calls[0]![0] as string) as string[];
    expect(blockerIds.sort()).toEqual([...returnedIds].sort());

    // The page is a strict subset of the board's 6 cards — proving the lookups
    // scale with page size, not total card count.
    expect(returnedIds.length).toBeLessThan(6);
  });

  it('recomputes the label facet at most once after a write, then serves it cached', async () => {
    const { projectId, columnId } = await setup();
    await createCard(projectId, { columnId, title: 'Seed', labels: 'one' });
    await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200); // prime clean

    // A new card with a new label flips the dirty flag via trigger.
    await createCard(projectId, { columnId, title: 'Fresh card', labels: 'two' });

    const spies = spyCardScans();
    const first = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    expect(spies.labelScan).toHaveBeenCalledTimes(1); // one recompute
    expect((first.body as { availableLabels: string[] }).availableLabels).toEqual(
      expect.arrayContaining(['one', 'two']),
    );

    // Board is clean again — a subsequent read does not re-scan.
    await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    expect(spies.labelScan).toHaveBeenCalledTimes(1);
  });

  it('drops a label from the facet once no card carries it', async () => {
    const { projectId, columnId } = await setup();
    const card = await createCard(projectId, { columnId, title: 'Only labelled', labels: 'solo' });
    let res = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    expect((res.body as { availableLabels: string[] }).availableLabels).toContain('solo');

    await request.delete(`/api/projects/${projectId}/board/cards/${card.id}`).expect(200);
    res = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    expect((res.body as { availableLabels: string[] }).availableLabels).not.toContain('solo');
  });

  it('serves persisted epic state on the paginated path without loading cards', async () => {
    const { projectId, columnId, doneId } = await setup();
    const epicRes = await request
      .post(`/api/projects/${projectId}/board/epics`)
      .send({ name: 'Shipping epic' })
      .expect(200);
    const epicId = (epicRes.body as { id: string }).id;
    const card = await createCard(projectId, {
      columnId,
      title: 'Epic card',
      epicId,
    });
    await request
      .post(`/api/projects/${projectId}/board/cards/${card.id}/move`)
      .send({ columnId: doneId, position: 0 })
      .expect(200);

    const spies = spyCardScans();
    const res = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    expect(spies.fullBoard).not.toHaveBeenCalled();

    const epic = (res.body as { epics: Array<{ id: string; state: string }> }).epics.find(
      (e) => e.id === epicId,
    );
    expect(epic?.state).toBe('done');
  });

  it('still uses the full-board load on the non-paginated path', async () => {
    const { projectId, columnId } = await setup();
    await createCard(projectId, { columnId, title: 'Card full path', labels: 'delta' });

    const spies = spyCardScans();
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = res.body as { availableLabels: string[]; cursors?: unknown };

    expect(spies.fullBoard).toHaveBeenCalled();
    expect(body.cursors).toBeUndefined();
    expect(body.availableLabels).toContain('delta');
  });
});
