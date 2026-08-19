import { describe, it, expect, beforeAll } from 'vitest';
import type supertest from 'supertest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest, createProject, createAgent } from './helpers.js';
import { getOrCreateBoard } from '../routes/board.js';
import type { KanbanCardRow, Project, Stmts } from '../types.js';

let request: supertest.Agent;
let stmts: Stmts;

beforeAll(async () => {
  request = await getRequest();
  const dbModule = await import('../db.js');
  stmts = dbModule.stmts!;
});

describe('POST /api/projects/:projectId/wiki/document-backfill', () => {
  it('returns 404 for an unknown project', async () => {
    await request.post('/api/projects/does-not-exist/wiki/document-backfill').send({}).expect(404);
  });

  it('returns skipped when a docs project has no undocumented Done cards', async () => {
    const project = (await createProject({
      id: `wiki-doc-empty-${uuidv4().slice(0, 8)}`,
      name: 'Wiki Doc Empty',
    })) as unknown as Project;
    await createAgent({
      projectId: project.id,
      id: `wiki-doc-empty-docs-${uuidv4().slice(0, 8)}`,
      name: 'Docs',
      role: 'docs',
    });

    const res = await request
      .post(`/api/projects/${project.id}/wiki/document-backfill`)
      .send({})
      .expect(200);
    expect(res.body).toMatchObject({ skipped: true, reason: 'none_undocumented', queued: 0 });
  });

  it('starts a docs session when undocumented Done cards exist', async () => {
    const project = (await createProject({
      id: `wiki-doc-q-${uuidv4().slice(0, 8)}`,
      name: 'Wiki Doc Queue',
    })) as unknown as Project;
    const docs = await createAgent({
      projectId: project.id,
      id: `wiki-doc-q-docs-${uuidv4().slice(0, 8)}`,
      name: 'Docs',
      role: 'docs',
    });
    const board = getOrCreateBoard(stmts, project.id);
    const done = board.columns.find((c) => c.name.toLowerCase() === 'done')!;
    const cardId = uuidv4();
    stmts.createKanbanCard.run(
      cardId,
      done.id,
      board.board.id,
      'Undocumented architecture decision',
      'Needs a wiki page',
      'medium',
      null,
      null,
      null,
      null,
      null,
      null,
      0,
    );

    const res = await request
      .post(`/api/projects/${project.id}/wiki/document-backfill`)
      .send({ limit: 5 })
      .expect(201);
    expect(res.body).toMatchObject({
      skipped: false,
      reused: false,
      queued: 1,
      agentId: docs.id,
    });
    expect(typeof (res.body as { sessionId: string }).sessionId).toBe('string');
  });
});

describe('wiki write auto-stamps the linked card as documented', () => {
  it('marks the session-linked card when a page is created', async () => {
    const project = (await createProject({
      id: `wiki-stamp-${uuidv4().slice(0, 8)}`,
    })) as unknown as Project;
    const agent = await createAgent({
      projectId: project.id,
      id: `wiki-stamp-dev-${uuidv4().slice(0, 8)}`,
      name: 'Dev',
      role: 'dev',
    });
    const sessionId = uuidv4();
    stmts.createSession.run(
      sessionId,
      agent.id as string,
      'Session stamp',
      'claude-code',
      'x',
      0,
      0,
      1,
    );
    const board = getOrCreateBoard(stmts, project.id);
    const start = board.columns.find((c) => c.name.toLowerCase() !== 'done')!;
    const cardId = uuidv4();
    stmts.createKanbanCard.run(
      cardId,
      start.id,
      board.board.id,
      'Linked shipping card',
      null,
      'medium',
      null,
      null,
      sessionId,
      null,
      null,
      null,
      0,
    );

    await request
      .post(`/api/projects/${project.id}/wiki`)
      .set('X-Agent-Hub-Session-Id', sessionId)
      .send({
        title: `Stamp page ${cardId.slice(0, 8)}`,
        content: '# Decision\nWe stamp documented on wiki write.',
        category: 'conventions',
      })
      .expect(201);

    const after = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(after.documented).toBe(1);
  });

  it('does not stamp a card when the wiki write has no session header', async () => {
    const project = (await createProject({
      id: `wiki-nostamp-${uuidv4().slice(0, 8)}`,
    })) as unknown as Project;
    const agent = await createAgent({
      projectId: project.id,
      id: `wiki-nostamp-dev-${uuidv4().slice(0, 8)}`,
      name: 'Dev',
      role: 'dev',
    });
    const sessionId = uuidv4();
    stmts.createSession.run(
      sessionId,
      agent.id as string,
      'Session no-stamp',
      'claude-code',
      'x',
      0,
      0,
      1,
    );
    const board = getOrCreateBoard(stmts, project.id);
    const start = board.columns.find((c) => c.name.toLowerCase() !== 'done')!;
    const cardId = uuidv4();
    stmts.createKanbanCard.run(
      cardId,
      start.id,
      board.board.id,
      'Unstamped card',
      null,
      'medium',
      null,
      null,
      sessionId,
      null,
      null,
      null,
      0,
    );

    await request
      .post(`/api/projects/${project.id}/wiki`)
      .send({
        title: `No stamp page ${cardId.slice(0, 8)}`,
        content: '# Not linked from this request',
        category: 'general',
      })
      .expect(201);

    const after = stmts.getKanbanCard.get(cardId) as KanbanCardRow;
    expect(after.documented).toBe(0);
  });
});
