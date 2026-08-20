import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { getRequest, createCard, createProject } from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;
let doneColumnId: string;
let inProgressColumnId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;

  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const columns = (boardRes.body as { columns: Array<{ id: string; name: string }> }).columns;
  doneColumnId = columns.find((c) => c.name === 'Done')!.id;
  inProgressColumnId = columns.find((c) => c.name === 'In Progress')!.id;
});

function moveCard(
  cardId: string,
  columnId: string,
  extra: Record<string, unknown> = {},
): supertest.Test {
  return request
    .post(`/api/projects/${projectId}/board/cards/${cardId}/move`)
    .send({ columnId, ...extra });
}

async function addComment(cardId: string, content: string): Promise<void> {
  await request
    .post(`/api/projects/${projectId}/board/cards/${cardId}/comments`)
    .send({ author: 'Test', content })
    .expect(200);
}

async function columnOf(cardId: string): Promise<string | undefined> {
  const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
  return (board.body as { cards: Array<{ id: string; column_id: string }> }).cards.find(
    (c) => c.id === cardId,
  )?.column_id;
}

describe('POST /board/cards/:cardId/move — Done-state contract guard', () => {
  it('rejects a [Partial] card into Done with no follow-up card IDs', async () => {
    const card = await createCard(projectId, { title: '[Partial] replace crons' });
    await addComment(card.id as string, 'crons still coexist, tracked as a follow-up');
    const res = await moveCard(card.id as string, doneColumnId);
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('done_state_contract_violation');
    expect(String(res.body.message)).toMatch(/follow-up card IDs/i);
    expect(await columnOf(card.id as string)).not.toBe(doneColumnId);
  });

  it('allows a [Partial] card into Done once a comment lists follow-up card IDs', async () => {
    const card = await createCard(projectId, { title: '[Spec] replace crons' });
    await addComment(card.id as string, 'Split into follow-ups #4242 and #4243');
    const res = await moveCard(card.id as string, doneColumnId);
    expect(res.status).toBe(200);
    expect((res.body as { column_id: string }).column_id).toBe(doneColumnId);
  });

  it('allows a full-scope (unprefixed) card into Done with no comments', async () => {
    const card = await createCard(projectId, { title: 'Fully shipped feature' });
    await moveCard(card.id as string, doneColumnId).expect(200);
  });

  it('does not block non-Done moves for a [Partial] card', async () => {
    const card = await createCard(projectId, { title: '[Partial] still working' });
    await moveCard(card.id as string, inProgressColumnId).expect(200);
  });

  it('force: true bypasses the guard', async () => {
    const card = await createCard(projectId, { title: '[Partial] no follow-ups' });
    const res = await moveCard(card.id as string, doneColumnId, { force: true });
    expect(res.status).toBe(200);
    expect((res.body as { column_id: string }).column_id).toBe(doneColumnId);
  });
});
