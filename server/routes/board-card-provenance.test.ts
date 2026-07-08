/**
 * Capture-provenance on kanban cards (spec CAPTURE-PROVENANCE).
 *
 * The card create path accepts an optional `source` ref
 * `{ sourceType, sourceId, sourceMeta }` and persists it on `kanban_cards`; the
 * serialized card exposes `source_type` / `source_id` / `source_meta` (the last
 * parsed from its stored JSON blob). Cards created without a source stay null.
 */
import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';

let request: supertest.Agent;
let projectId: string;
let columnId: string;

interface SerializedCard {
  id: string;
  title: string;
  source_type: string | null;
  source_id: string | null;
  source_meta: Record<string, unknown> | null;
}

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
  const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
  columnId = (boardRes.body as { columns: Array<{ id: string }> }).columns[0].id;
});

function post(body: Record<string, unknown>) {
  return request.post(`/api/projects/${projectId}/board/cards`).send(body);
}

describe('POST /board/cards — capture provenance', () => {
  it('stamps an email source ref and preserves the deep link in source_meta', async () => {
    const res = await post({
      title: 'Provenance: from email',
      columnId,
      source: {
        sourceType: 'email',
        sourceId: 'gmail-msg-abc',
        sourceMeta: { link: 'https://mail.google.com/mail/u/0/#inbox/abc', subject: 'Ship it' },
      },
    }).expect(200);
    const card = res.body as SerializedCard;
    expect(card.source_type).toBe('email');
    expect(card.source_id).toBe('gmail-msg-abc');
    expect(card.source_meta).toEqual({
      link: 'https://mail.google.com/mail/u/0/#inbox/abc',
      subject: 'Ship it',
    });

    // Provenance survives a re-read of the board (persisted, not just echoed).
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const reread = (board.body as { cards: SerializedCard[] }).cards.find((c) => c.id === card.id);
    expect(reread?.source_type).toBe('email');
    expect(reread?.source_meta).toEqual({
      link: 'https://mail.google.com/mail/u/0/#inbox/abc',
      subject: 'Ship it',
    });
  });

  it('accepts a todo-promotion source ref (card sources include `todo`)', async () => {
    const res = await post({
      title: 'Provenance: promoted from todo',
      columnId,
      source: { sourceType: 'todo', sourceId: 'todo-123' },
    }).expect(200);
    const card = res.body as SerializedCard;
    expect(card.source_type).toBe('todo');
    expect(card.source_id).toBe('todo-123');
    expect(card.source_meta).toBeNull();
  });

  it('leaves provenance null when no source ref is supplied', async () => {
    const res = await post({ title: 'Provenance: none', columnId }).expect(200);
    const card = res.body as SerializedCard;
    expect(card.source_type).toBeNull();
    expect(card.source_id).toBeNull();
    expect(card.source_meta).toBeNull();
  });

  it('rejects an unknown source_type at the schema layer', async () => {
    await post({
      title: 'Provenance: bogus type',
      columnId,
      source: { sourceType: 'slack', sourceId: 'x' },
    }).expect(400);
  });
});
