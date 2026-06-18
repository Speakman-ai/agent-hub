import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject, createCard } from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;
let columnId: string;
let columnIdB: string;

interface CardRow {
  id: string;
  title: string;
  short_id: number | null;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  const cols = (boardRes.body as { columns: Array<{ id: string }> }).columns;
  columnId = cols[0].id;
  columnIdB = cols[1].id;
});

describe('kanban short ids', () => {
  it('assigns a monotonic per-board short id on create', async () => {
    const a = (await createCard(projectId, {
      columnId,
      title: 'short-id A',
    })) as unknown as CardRow;
    const b = (await createCard(projectId, {
      columnId,
      title: 'short-id B',
    })) as unknown as CardRow;
    // Different column, same board — counter is board-scoped, not column-scoped.
    const c = (await createCard(projectId, {
      columnId: columnIdB,
      title: 'short-id C',
    })) as unknown as CardRow;

    expect(typeof a.short_id).toBe('number');
    expect(b.short_id).toBe((a.short_id as number) + 1);
    expect(c.short_id).toBe((b.short_id as number) + 1);
  });

  it('never reuses a number after a delete (no gaps-cause-collision)', async () => {
    const x = (await createCard(projectId, {
      columnId,
      title: 'short-id X',
    })) as unknown as CardRow;
    await request.delete(`/api/projects/${projectId}/board/cards/${x.id}`).expect(200);
    const y = (await createCard(projectId, {
      columnId,
      title: 'short-id Y',
    })) as unknown as CardRow;
    // The deleted card's number is not handed back out.
    expect(y.short_id).toBe((x.short_id as number) + 1);
  });

  it('exposes a derived card_prefix on the board payload', async () => {
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const board = (res.body as { board: { card_prefix?: string; card_seq: number } }).board;
    expect(typeof board.card_prefix).toBe('string');
    expect((board.card_prefix as string).length).toBeGreaterThanOrEqual(2);
    expect(board.card_seq).toBeGreaterThan(0);
  });

  it('every card in the board payload carries a short id', async () => {
    const res = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const cards = (res.body as { cards: CardRow[] }).cards;
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(typeof card.short_id).toBe('number');
    }
    // ids are unique within the board
    const ids = cards.map((c) => c.short_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('derives the prefix from the immutable slug, not the display name', async () => {
    const proj = await createProject({ id: 'regress-prefix-proj', name: 'Zebra Quokka Yak' });
    const pid = proj.id as string;
    const res = await request.get(`/api/projects/${pid}/board`).expect(200);
    const board = (res.body as { board: { card_prefix?: string } }).board;
    // Slug "regress-prefix-proj" → "RPP"; NOT the name's "ZQY".
    expect(board.card_prefix).toBe('RPP');
  });

  // Regression: card ids are stable, copy/shareable references. Renaming the
  // project must NOT rewrite the prefix on existing cards (previously the prefix
  // was re-derived from project.name on every board load).
  it('keeps card_prefix stable across a project rename', async () => {
    const proj = await createProject({ id: 'rename-stable-proj', name: 'Rename Stable Proj' });
    const pid = proj.id as string;

    await createCard(pid, { title: 'before rename' });
    const before = await request.get(`/api/projects/${pid}/board`).expect(200);
    const prefixBefore = (before.body as { board: { card_prefix?: string } }).board.card_prefix;
    expect(prefixBefore).toBe('RSP');

    // Rename the project to something with totally different initials.
    await request.patch(`/api/projects/${pid}`).send({ name: 'Wholly Different Name' }).expect(200);

    const after = await request.get(`/api/projects/${pid}/board`).expect(200);
    const prefixAfter = (after.body as { board: { card_prefix?: string } }).board.card_prefix;
    expect(prefixAfter).toBe(prefixBefore);
    expect(prefixAfter).toBe('RSP');
  });
});
