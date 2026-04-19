/**
 * Integration tests for the kanban card-blocker endpoints and the GET /board
 * enrichment that exposes blocker relationships to the client.
 */

import type supertest from 'supertest';
import { getRequest, createProject, createCard } from './helpers.js';

let request: supertest.Agent;
let projectId: string;
let columns: Array<{ id: string; name: string }>;
let backlogColumnId: string;
let inProgressColumnId: string;
let doneColumnId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const body = boardRes.body as { columns: Array<{ id: string; name: string }> };
  columns = body.columns;
  backlogColumnId = columns.find((c) => c.name === 'Backlog')?.id as string;
  inProgressColumnId = columns.find((c) => c.name === 'In Progress')?.id as string;
  doneColumnId = columns.find((c) => c.name === 'Done')?.id as string;
});

type CardResp = { id: string };

async function makeCard(title: string, columnId = backlogColumnId): Promise<string> {
  const card = (await createCard(projectId, { title, columnId })) as unknown as CardResp;
  return card.id;
}

describe('POST /board/cards/:cardId/blockers', () => {
  it('creates a blocker link and returns 201', async () => {
    const a = await makeCard('post-link-a');
    const b = await makeCard('post-link-b');
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(201);
    expect(res.body.card_id).toBe(a);
    expect(res.body.blocked_by_card_id).toBe(b);
    expect(typeof res.body.id).toBe('string');
  });

  it('400s when blockedByCardId is missing', async () => {
    const a = await makeCard('post-missing-a');
    await request.post(`/api/projects/${projectId}/board/cards/${a}/blockers`).send({}).expect(400);
  });

  it('400s when blockedByCardId equals cardId (self-block)', async () => {
    const a = await makeCard('post-self-a');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: a })
      .expect(400);
  });

  it('404s when either card does not exist', async () => {
    const a = await makeCard('post-404-a');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: 'nonexistent-card-id' })
      .expect(404);
    await request
      .post(`/api/projects/${projectId}/board/cards/nonexistent/blockers`)
      .send({ blockedByCardId: a })
      .expect(404);
  });

  it('409s with error:duplicate on repeat insert', async () => {
    const a = await makeCard('post-dup-a');
    const b = await makeCard('post-dup-b');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(201);
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(409);
    expect(res.body.error).toBe('duplicate');
  });

  it('409s with error:cycle when the edge would close a loop', async () => {
    const a = await makeCard('post-cyc-a');
    const b = await makeCard('post-cyc-b');
    const c = await makeCard('post-cyc-c');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/board/cards/${b}/blockers`)
      .send({ blockedByCardId: c })
      .expect(201);
    // Proposing c → a would cycle a→b→c→a
    const res = await request
      .post(`/api/projects/${projectId}/board/cards/${c}/blockers`)
      .send({ blockedByCardId: a })
      .expect(409);
    expect(res.body.error).toBe('cycle');
    expect(Array.isArray(res.body.path)).toBe(true);
    expect(res.body.path.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects cross-project blockers (404)', async () => {
    const otherProject = (await createProject()) as { id: string };
    const otherBoard = (await request.get(`/api/projects/${otherProject.id}/board`).expect(200))
      .body as { columns: Array<{ id: string }> };
    const otherColId = otherBoard.columns[0]?.id;
    const mine = await makeCard('cross-mine');
    const theirs = (await createCard(otherProject.id, {
      title: 'cross-theirs',
      columnId: otherColId,
    })) as unknown as CardResp;
    await request
      .post(`/api/projects/${projectId}/board/cards/${mine}/blockers`)
      .send({ blockedByCardId: theirs.id })
      .expect(404);
  });
});

describe('DELETE /board/cards/:cardId/blockers/:blockedByCardId', () => {
  it('removes an existing link and returns 204', async () => {
    const a = await makeCard('del-a');
    const b = await makeCard('del-b');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(201);
    await request.delete(`/api/projects/${projectId}/board/cards/${a}/blockers/${b}`).expect(204);
    // Board GET no longer lists the edge.
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (boardRes.body.cards as Array<{ id: string; blockers: unknown[] }>).find(
      (c) => c.id === a,
    );
    expect(card?.blockers).toEqual([]);
  });

  it('404s when the link does not exist', async () => {
    const a = await makeCard('del-404-a');
    const b = await makeCard('del-404-b');
    await request.delete(`/api/projects/${projectId}/board/cards/${a}/blockers/${b}`).expect(404);
  });

  it('cascades when the blocker card is deleted', async () => {
    const a = await makeCard('cascade-a');
    const b = await makeCard('cascade-b');
    await request
      .post(`/api/projects/${projectId}/board/cards/${a}/blockers`)
      .send({ blockedByCardId: b })
      .expect(201);
    await request.delete(`/api/projects/${projectId}/board/cards/${b}`).expect(200);
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (boardRes.body.cards as Array<{ id: string; blockers: unknown[] }>).find(
      (c) => c.id === a,
    );
    expect(card?.blockers).toEqual([]);
  });
});

describe('GET /board enrichment', () => {
  it('returns blockers and blocks arrays on every card, empty when none', async () => {
    const a = await makeCard('enrich-empty');
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (
      boardRes.body.cards as Array<{
        id: string;
        blockers: unknown[];
        blocks: unknown[];
      }>
    ).find((c) => c.id === a);
    expect(card?.blockers).toEqual([]);
    expect(card?.blocks).toEqual([]);
  });

  it('annotates blocker shape with done:true when blocker is in Done column', async () => {
    const work = await makeCard('enrich-work', inProgressColumnId);
    const blocker = await makeCard('enrich-blocker-done', doneColumnId);
    await request
      .post(`/api/projects/${projectId}/board/cards/${work}/blockers`)
      .send({ blockedByCardId: blocker })
      .expect(201);
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const workCard = (
      boardRes.body.cards as Array<{
        id: string;
        blockers: Array<{ id: string; title: string; column_id: string; done: boolean }>;
      }>
    ).find((c) => c.id === work);
    expect(workCard?.blockers).toHaveLength(1);
    expect(workCard?.blockers[0]?.id).toBe(blocker);
    expect(workCard?.blockers[0]?.done).toBe(true);
    expect(workCard?.blockers[0]?.column_id).toBe(doneColumnId);
  });

  it('annotates done:false when blocker is NOT in a Done column', async () => {
    const work = await makeCard('enrich-work2', inProgressColumnId);
    const blocker = await makeCard('enrich-blocker-open', inProgressColumnId);
    await request
      .post(`/api/projects/${projectId}/board/cards/${work}/blockers`)
      .send({ blockedByCardId: blocker })
      .expect(201);
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const workCard = (
      boardRes.body.cards as Array<{
        id: string;
        blockers: Array<{ done: boolean }>;
      }>
    ).find((c) => c.id === work);
    expect(workCard?.blockers[0]?.done).toBe(false);
  });

  it('populates the inverse blocks array on the blocking card', async () => {
    const work = await makeCard('enrich-inv-work');
    const blocker = await makeCard('enrich-inv-blocker');
    await request
      .post(`/api/projects/${projectId}/board/cards/${work}/blockers`)
      .send({ blockedByCardId: blocker })
      .expect(201);
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const blockerCard = (
      boardRes.body.cards as Array<{
        id: string;
        blocks: Array<{ id: string }>;
      }>
    ).find((c) => c.id === blocker);
    expect(blockerCard?.blocks).toHaveLength(1);
    expect(blockerCard?.blocks[0]?.id).toBe(work);
  });
});
