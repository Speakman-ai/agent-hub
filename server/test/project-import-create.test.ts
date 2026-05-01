import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import { getRequest } from './helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

/**
 * Coverage for `POST /api/projects/import` — the create-from-export path.
 *
 * The per-project import (`/api/projects/:projectId/import`) requires the
 * target project to already exist; this endpoint creates the project as part
 * of the import so a user can drop in an export file without scaffolding an
 * empty project first.
 *
 * The id-collision suffix uses Math.random, so collisions cannot be asserted
 * deterministically. We instead assert the high-level invariants: a unique id
 * is allocated, the new project shows up in the project list, and the
 * exported sections (kanban, wiki, crons) land in the new project's board /
 * wiki / cron list.
 */
describe('POST /api/projects/import — create from export', () => {
  function makeExport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 3,
      type: 'project',
      project: {
        id: `imp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: 'Imported Project',
        cwd: '/tmp',
        color: '#abcdef',
        agents: [],
      },
      ...overrides,
    };
  }

  it('400s on missing/invalid export envelope', async () => {
    await request.post('/api/projects/import').send({}).expect(400);
    await request.post('/api/projects/import').send({ version: 2, type: 'project' }).expect(400);
    await request.post('/api/projects/import').send({ version: 3, type: 'config' }).expect(400);
  });

  it('400s when the export omits the project block (no project to create)', async () => {
    const res = await request
      .post('/api/projects/import')
      .send({ version: 3, type: 'project', wiki: [] })
      .expect(400);
    expect(res.body.error).toMatch(/project/i);
  });

  it('creates a new project using the exported id when free', async () => {
    const desired = `imp-fresh-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const res = await request
      .post('/api/projects/import')
      .send(
        makeExport({
          project: {
            id: desired,
            name: 'Fresh Imported',
            cwd: '/tmp',
            color: '#123456',
            agents: [],
          },
        }),
      )
      .expect(201);

    expect(res.body.project.id).toBe(desired);
    expect(res.body.project.name).toBe('Fresh Imported');
    expect(res.body.project.color).toBe('#123456');

    const list = await request.get('/api/projects').expect(200);
    const found = (list.body as Array<{ id: string }>).find((p) => p.id === desired);
    expect(found).toBeDefined();
  });

  it('allocates a fresh id when the exported id collides with an existing project', async () => {
    // First import claims the id.
    const desired = `imp-coll-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await request
      .post('/api/projects/import')
      .send(
        makeExport({
          project: { id: desired, name: 'First', cwd: '/tmp', color: '#111111', agents: [] },
        }),
      )
      .expect(201);

    // Second import with the SAME exported id must succeed and get a
    // different id — no 409.
    const res2 = await request
      .post('/api/projects/import')
      .send(
        makeExport({
          project: { id: desired, name: 'Second', cwd: '/tmp', color: '#222222', agents: [] },
        }),
      )
      .expect(201);

    expect(res2.body.project.id).not.toBe(desired);
    expect(res2.body.project.id.startsWith(desired + '-')).toBe(true);
  });

  it('slugifies the project name when the exported id is not URL-safe', async () => {
    const res = await request
      .post('/api/projects/import')
      .send(
        makeExport({
          project: {
            // Invalid id with spaces / punctuation — should be ignored in
            // favor of a slug derived from the name.
            id: 'NOT a valid id!',
            name: `Slug Me ${Date.now()}`,
            cwd: '/tmp',
            color: '#abcdef',
            agents: [],
          },
        }),
      )
      .expect(201);

    expect(res.body.project.id).toMatch(/^[a-z0-9-]+$/);
    expect(res.body.project.id).toMatch(/^slug-me-/);
  });

  it('imports kanban + wiki sections into the freshly-created project', async () => {
    const cardTitle = `imp-card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const wikiSlug = `imp-page-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const desired = `imp-data-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const res = await request
      .post('/api/projects/import')
      .send({
        version: 3,
        type: 'project',
        project: {
          id: desired,
          name: 'With Data',
          cwd: '/tmp',
          color: '#abcdef',
          agents: [],
        },
        wiki: [
          {
            slug: wikiSlug,
            title: 'Imported Page',
            content: '# Hello',
            category: 'general',
            updated_by: 'test',
          },
        ],
        kanban: {
          board: { name: 'Imported Board' },
          columns: [
            { id: 'c1', name: 'Backlog', position: 0, color: '#6B7280' },
            { id: 'c2', name: 'Done', position: 1, color: '#10B981' },
          ],
          epics: [],
          cards: [
            {
              id: 'k1',
              column_id: 'c1',
              title: cardTitle,
              description: '',
              priority: 'medium',
              assignee: '',
              labels: '',
              position: 0,
            },
          ],
          comments: {},
        },
      })
      .expect(201);

    const newId = res.body.project.id as string;
    expect(res.body.results.kanban).toBeTruthy();
    expect(res.body.results.wiki).toBeTruthy();

    const board = await request.get(`/api/projects/${newId}/board`).expect(200);
    const card = (board.body.cards as Array<{ title: string }>).find((c) => c.title === cardTitle);
    expect(card).toBeDefined();

    const wiki = await request.get(`/api/projects/${newId}/wiki/${wikiSlug}`).expect(200);
    expect(wiki.body.title).toBe('Imported Page');
  });
});
