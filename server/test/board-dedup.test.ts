import type supertest from 'supertest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;
let projectId: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject();
  projectId = project.id as string;
});

// ═══════════════════════════════════════════════════════════════════
// Board card deduplication
// ═══════════════════════════════════════════════════════════════════

describe('Card creation deduplication', () => {
  let columnId: string;

  beforeAll(async () => {
    const boardRes = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const body = boardRes.body as { columns: Array<{ id: string; name: string }> };
    columnId = body.columns[0]?.id;
  });

  it('returns existing card when creating with duplicate title', async () => {
    const title = 'Unique dedup test card';

    // First creation succeeds
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title, columnId, description: 'first' })
      .expect(200);
    const card1 = res1.body as { id: string; title: string };
    expect(card1.title).toBe(title);

    // Second creation with same title returns existing card
    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title, columnId, description: 'second' })
      .expect(200);
    const card2 = res2.body as { id: string; title: string };
    expect(card2.id).toBe(card1.id);
  });

  it('deduplicates case-insensitively', async () => {
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Case Test Card', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'case test card', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).toBe(card1.id);
  });

  it('allows cards with different titles', async () => {
    const res1 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card Alpha', columnId })
      .expect(200);
    const card1 = res1.body as { id: string };

    const res2 = await request
      .post(`/api/projects/${projectId}/board/cards`)
      .send({ title: 'Card Beta', columnId })
      .expect(200);
    const card2 = res2.body as { id: string };

    expect(card2.id).not.toBe(card1.id);
  });
});
