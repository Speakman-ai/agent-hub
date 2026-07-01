import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest, createProject } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

describe('POST /api/projects/:projectId/import — kanban assign_model', () => {
  it('persists assign_model when imported card has no epic', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await request.get(`/api/projects/${projectId}/board`).expect(200);

    const uniqueTitle = `import-assign-model-${Date.now()}`;
    const sonnet = 'claude-sonnet-5';

    await request
      .post(`/api/projects/${projectId}/import`)
      .send({
        version: 3,
        type: 'project',
        kanban: {
          board: { name: 'Import Test Board' },
          columns: [
            { id: 'lex-td', name: 'To Do', position: 0, color: '#3B82F6' },
            { id: 'lex-ip', name: 'In Progress', position: 1, color: '#F59E0B' },
            { id: 'lex-rv', name: 'Review', position: 2, color: '#8B5CF6' },
            { id: 'lex-dn', name: 'Done', position: 3, color: '#10B981' },
          ],
          epics: [],
          cards: [
            {
              id: 'lex-card-1',
              column_id: 'lex-td',
              title: uniqueTitle,
              description: '',
              priority: 'medium',
              assignee: '',
              labels: '',
              position: 0,
              assign_model: sonnet,
            },
          ],
          comments: {},
        },
      })
      .expect(200);

    const after = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (after.body.cards as Array<{ title: string; assign_model?: string | null }>).find(
      (c) => c.title === uniqueTitle,
    );
    expect(card).toBeDefined();
    expect(card!.assign_model).toBe(sonnet);
  });

  it('drops assign_model when import JSON contains an invalid model', async () => {
    const project = await createProject();
    const projectId = project.id as string;

    await request.get(`/api/projects/${projectId}/board`).expect(200);

    const uniqueTitle = `import-bad-assign-model-${Date.now()}`;

    await request
      .post(`/api/projects/${projectId}/import`)
      .send({
        version: 3,
        type: 'project',
        kanban: {
          board: { name: 'Import Test Board' },
          columns: [
            { id: 'lex-td', name: 'To Do', position: 0, color: '#3B82F6' },
            { id: 'lex-ip', name: 'In Progress', position: 1, color: '#F59E0B' },
            { id: 'lex-rv', name: 'Review', position: 2, color: '#8B5CF6' },
            { id: 'lex-dn', name: 'Done', position: 3, color: '#10B981' },
          ],
          epics: [],
          cards: [
            {
              id: 'lex-card-bad',
              column_id: 'lex-td',
              title: uniqueTitle,
              description: '',
              priority: 'medium',
              assignee: '',
              labels: '',
              position: 0,
              assign_model: 'totally-fake-model-not-in-allowlist',
            },
          ],
          comments: {},
        },
      })
      .expect(200);

    const after = await request.get(`/api/projects/${projectId}/board`).expect(200);
    const card = (after.body.cards as Array<{ title: string; assign_model?: string | null }>).find(
      (c) => c.title === uniqueTitle,
    );
    expect(card).toBeDefined();
    expect(card!.assign_model).toBeNull();
  });
});
