import type supertest from 'supertest';
import { createCard, createProject, getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('Board label facets', () => {
  it('returns labels from the full board when cards are paginated', async () => {
    const project = await createProject();
    const projectId = project.id as string;
    const board = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const columnId = (board.body as { columns: Array<{ id: string }> }).columns[0].id;

    await createCard(projectId, {
      title: 'Visible first-page card',
      columnId,
      labels: 'visible',
    });
    await createCard(projectId, {
      title: 'Off-page labeled card',
      columnId,
      labels: 'hidden, visible',
    });

    const paged = await request.get(`/api/projects/${projectId}/board?limit=1`).expect(200);
    const body = paged.body as {
      cards: Array<{ title: string }>;
      availableLabels: string[];
    };
    expect(body.cards.map((card) => card.title)).toContain('Visible first-page card');
    expect(body.cards.map((card) => card.title)).not.toContain('Off-page labeled card');
    expect(body.availableLabels).toEqual(['hidden', 'visible']);
  });
});
