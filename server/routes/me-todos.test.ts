/**
 * Integration tests for the personal-todos REST surface (`/api/me/todos`).
 *
 * Locks the two invariants the epic spec cares about:
 *   1. Every route scopes to `req.authUserId` — user B can never read, mutate,
 *      or delete user A's todos (a foreign id 404s, and a list only returns the
 *      caller's rows).
 *   2. Each write broadcasts a `user_todo_update` event stamped with the owner
 *      uid, and the broadcast filter delivers it only to that owner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';

let TMP_DIR = '';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { getOrgsDb } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { listTodos, setTodoLink } = await import('../user-todos-store.js');
const { default: createMeTodosRoutes } = await import('./me-todos.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');
const { initDb, getStmts } = await import('../db.js');
const { getOrCreateBoard } = await import('./board.js');

const broadcast = vi.fn();
const PROJECT_ID = 'todo-promote-project';
const PRIVATE_PROJECT_ID = 'private-todo-promote-project';
const project = {
  id: PROJECT_ID,
  name: 'Todo Promote Project',
  cwd: '/tmp/todo-promote-project',
  agents: [],
} as unknown as Project;

function makeDeps(): RouteDeps {
  return {
    broadcast,
    stmts: getStmts(),
    findProject: (id: string) => {
      if (id === PROJECT_ID) return project;
      if (id === PRIVATE_PROJECT_ID) {
        return {
          id: PRIVATE_PROJECT_ID,
          name: 'Private Todo Promote Project',
          cwd: '/tmp/private-todo-promote-project',
          agents: [],
          visibility: 'private',
          ownerUserId: userA,
        } as unknown as Project;
      }
      return null;
    },
  } as unknown as RouteDeps;
}

/** Mount the router behind a middleware that stamps a fixed acting user. */
function mountWithDeps(authUserId: string | null, deps: RouteDeps): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) {
      Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    }
    next();
  });
  app.use(createMeTodosRoutes(deps));
  return app;
}

function mount(authUserId: string | null): Express {
  return mountWithDeps(authUserId, makeDeps());
}

let userA = '';
let userB = '';

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'me-todos-route-'));
  initDb(TMP_DIR);
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'user-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'user-b', passwordHash: 'x' }).id;
  broadcast.mockClear();
});

describe('POST /api/me/todos', () => {
  it('creates a todo, returns 201, and broadcasts user_todo_update to the owner', async () => {
    const res = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: '  Buy milk  ', notes: 'skim' })
      .expect(201);

    expect(res.body.todo).toMatchObject({
      userId: userA,
      title: 'Buy milk', // trimmed
      notes: 'skim',
      status: 'open',
      position: 0,
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_todo_update', ownerUserId: userA, action: 'created' }),
    );
  });

  it('rejects a missing/empty title with 400 and no broadcast', async () => {
    await request(mount(userA)).post('/api/me/todos').send({ title: '   ' }).expect(400);
    await request(mount(userA)).post('/api/me/todos').send({}).expect(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects an unknown sourceType with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', sourceType: 'slack' })
      .expect(400);
  });

  it('creates with priority and a do-date window', async () => {
    const res = await request(mount(userA))
      .post('/api/me/todos')
      .send({
        title: 'scheduled task',
        priority: 'high',
        doDate: '2026-07-10',
        doStartAt: '2026-07-10T09:00:00.000Z',
        doEndAt: '2026-07-10T10:30:00.000Z',
      })
      .expect(201);

    expect(res.body.todo).toMatchObject({
      priority: 'high',
      doDate: '2026-07-10',
      doStartAt: '2026-07-10T09:00:00.000Z',
      doEndAt: '2026-07-10T10:30:00.000Z',
    });
  });

  it('defaults priority to medium when omitted', async () => {
    const res = await request(mount(userA)).post('/api/me/todos').send({ title: 'x' }).expect(201);
    expect(res.body.todo.priority).toBe('medium');
  });

  it('rejects an invalid priority enum with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', priority: 'critical' })
      .expect(400);
  });

  it('rejects a non-ISO doDate with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', doDate: 'not-a-date' })
      .expect(400);
  });

  it('creates already linked to a card', async () => {
    const res = await request(mount(userA))
      .post('/api/me/todos')
      .send({
        title: 'linked',
        linkedType: 'card',
        linkedId: 'card-123',
        linkedProjectId: 'proj-1',
      })
      .expect(201);

    expect(res.body.todo).toMatchObject({
      linkedType: 'card',
      linkedId: 'card-123',
      linkedProjectId: 'proj-1',
      linkedCardId: 'card-123', // back-compat column kept in sync
    });
  });

  it('rejects linkedType without linkedId with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', linkedType: 'card' })
      .expect(400);
  });

  it('rejects linkedId without linkedType with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', linkedId: 'card-1' })
      .expect(400);
  });

  it('rejects an unknown linkedType with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'x', linkedType: 'pullrequest', linkedId: 'pr-1' })
      .expect(400);
  });

  it('401s when unauthenticated', async () => {
    await request(mount(null)).post('/api/me/todos').send({ title: 'x' }).expect(401);
  });
});

describe('GET /api/me/todos', () => {
  it('returns only the calling user rows (cross-user isolation)', async () => {
    await request(mount(userA)).post('/api/me/todos').send({ title: 'A-1' }).expect(201);
    await request(mount(userA)).post('/api/me/todos').send({ title: 'A-2' }).expect(201);
    await request(mount(userB)).post('/api/me/todos').send({ title: 'B-1' }).expect(201);

    const aRes = await request(mount(userA)).get('/api/me/todos').expect(200);
    expect(aRes.body.todos.map((t: { title: string }) => t.title)).toEqual(['A-1', 'A-2']);

    const bRes = await request(mount(userB)).get('/api/me/todos').expect(200);
    expect(bRes.body.todos.map((t: { title: string }) => t.title)).toEqual(['B-1']);
  });

  it('filters by ?status and rejects a bad status', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'todo' });
    await request(mount(userA))
      .put(`/api/me/todos/${created.body.todo.id}`)
      .send({ status: 'done' })
      .expect(200);
    await request(mount(userA)).post('/api/me/todos').send({ title: 'open one' }).expect(201);

    const open = await request(mount(userA)).get('/api/me/todos?status=open').expect(200);
    expect(open.body.todos.map((t: { title: string }) => t.title)).toEqual(['open one']);

    const done = await request(mount(userA)).get('/api/me/todos?status=done').expect(200);
    expect(done.body.todos.map((t: { title: string }) => t.title)).toEqual(['todo']);

    await request(mount(userA)).get('/api/me/todos?status=nope').expect(400);
  });
});

describe('PUT /api/me/todos/:id', () => {
  it("updates the caller's todo and broadcasts", async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    broadcast.mockClear();

    const res = await request(mount(userA))
      .put(`/api/me/todos/${created.body.todo.id}`)
      .send({ title: 'renamed', status: 'done' })
      .expect(200);

    expect(res.body.todo).toMatchObject({ title: 'renamed', status: 'done' });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_todo_update', ownerUserId: userA, action: 'updated' }),
    );
  });

  it("404s (not 403) when user B tries to update user A's todo, and does not mutate it", async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'A private' });
    broadcast.mockClear();

    await request(mount(userB))
      .put(`/api/me/todos/${created.body.todo.id}`)
      .send({ title: 'hijacked' })
      .expect(404);

    // Untouched in storage, and no owner broadcast fired.
    expect(listTodos(userA)[0].title).toBe('A private');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects an empty title and a bad status with 400', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    const id = created.body.todo.id;
    await request(mount(userA)).put(`/api/me/todos/${id}`).send({ title: '  ' }).expect(400);
    await request(mount(userA)).put(`/api/me/todos/${id}`).send({ status: 'x' }).expect(400);
  });

  it('updates priority and the do-date window', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    const id = created.body.todo.id;

    const res = await request(mount(userA))
      .put(`/api/me/todos/${id}`)
      .send({ priority: 'urgent', doDate: '2026-08-01' })
      .expect(200);
    expect(res.body.todo).toMatchObject({ priority: 'urgent', doDate: '2026-08-01' });

    // A null clears the scheduling date back out.
    const cleared = await request(mount(userA))
      .put(`/api/me/todos/${id}`)
      .send({ doDate: null })
      .expect(200);
    expect(cleared.body.todo.doDate).toBeNull();
  });

  it('rejects an invalid priority and a non-ISO doDate with 400', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    const id = created.body.todo.id;
    await request(mount(userA)).put(`/api/me/todos/${id}`).send({ priority: 'meh' }).expect(400);
    await request(mount(userA)).put(`/api/me/todos/${id}`).send({ doDate: 'xyz' }).expect(400);
  });

  it('sets and then clears the polymorphic link', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    const id = created.body.todo.id;

    const linked = await request(mount(userA))
      .put(`/api/me/todos/${id}`)
      .send({ linkedType: 'epic', linkedId: 'epic-9', linkedProjectId: 'proj-2' })
      .expect(200);
    expect(linked.body.todo).toMatchObject({
      linkedType: 'epic',
      linkedId: 'epic-9',
      linkedProjectId: 'proj-2',
    });

    const cleared = await request(mount(userA))
      .put(`/api/me/todos/${id}`)
      .send({ linkedType: null })
      .expect(200);
    expect(cleared.body.todo).toMatchObject({
      linkedType: null,
      linkedId: null,
      linkedProjectId: null,
    });
  });

  it('rejects linkedType without linkedId on update with 400', async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'orig' });
    const id = created.body.todo.id;
    await request(mount(userA))
      .put(`/api/me/todos/${id}`)
      .send({ linkedType: 'session' })
      .expect(400);
  });
});

describe('DELETE /api/me/todos/:id', () => {
  it("deletes the caller's todo and broadcasts", async () => {
    const created = await request(mount(userA)).post('/api/me/todos').send({ title: 'del me' });
    broadcast.mockClear();

    await request(mount(userA)).delete(`/api/me/todos/${created.body.todo.id}`).expect(200);
    expect(listTodos(userA)).toHaveLength(0);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'user_todo_update', ownerUserId: userA, action: 'deleted' }),
    );
  });

  it("404s when user B tries to delete user A's todo, leaving it intact", async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'A keeps this' });
    await request(mount(userB)).delete(`/api/me/todos/${created.body.todo.id}`).expect(404);
    expect(listTodos(userA)).toHaveLength(1);
  });
});

describe('POST /api/me/todos/:id/promote', () => {
  it('creates a To Do card, links the todo back to it, and stamps todo provenance', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Ship promote endpoint', notes: 'carry me over', priority: 'high' })
      .expect(201);
    broadcast.mockClear();

    const res = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);

    expect(res.body.todo).toMatchObject({
      id: created.body.todo.id,
      linkedType: 'card',
      linkedId: res.body.card.id,
      linkedCardId: res.body.card.id,
      linkedProjectId: PROJECT_ID,
      status: 'open',
    });
    expect(res.body.card).toMatchObject({
      title: 'Ship promote endpoint',
      description: 'carry me over',
      priority: 'high',
      source_type: 'todo',
      source_id: created.body.todo.id,
      source_meta: { todoId: created.body.todo.id, userId: userA },
      created_by: userA,
    });

    const board = getOrCreateBoard(getStmts(), PROJECT_ID);
    const todoColumn = board.columns.find((c) => c.name === 'To Do');
    expect(res.body.card.column_id).toBe(todoColumn?.id);
    expect(broadcast).toHaveBeenCalledWith({ type: 'kanban_update', projectId: PROJECT_ID });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_todo_update',
        ownerUserId: userA,
        action: 'promoted',
      }),
    );
  });

  it('honors columnId, epicId, and priority override', async () => {
    const board = getOrCreateBoard(getStmts(), PROJECT_ID);
    const customColumnId = 'promote-custom-column';
    getStmts().createKanbanColumn.run(customColumnId, board.board.id, 'Next', 99, null);
    const epicId = 'promote-epic';
    getStmts().createKanbanEpic.run(
      epicId,
      board.board.id,
      'Promote Epic',
      null,
      '#6366F1',
      0,
      null,
    );
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Custom target', priority: 'low' })
      .expect(201);

    const res = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID, columnId: customColumnId, epicId, priority: 'urgent' })
      .expect(201);

    expect(res.body.card).toMatchObject({
      column_id: customColumnId,
      epic_id: epicId,
      priority: 'urgent',
    });
  });

  it('rejects a column from another board', async () => {
    const foreignBoard = getOrCreateBoard(getStmts(), 'foreign-promote-project');
    const foreignColumnId = 'foreign-promote-column';
    getStmts().createKanbanColumn.run(foreignColumnId, foreignBoard.board.id, 'Foreign', 99, null);
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Wrong board column' })
      .expect(201);

    await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID, columnId: foreignColumnId })
      .expect(404);
  });

  it('rejects promoting into a private project the user cannot view', async () => {
    const created = await request(mount(userB))
      .post('/api/me/todos')
      .send({ title: 'No private project writes' })
      .expect(201);

    await request(mount(userB))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PRIVATE_PROJECT_ID })
      .expect(404);

    expect(getStmts().getKanbanBoard.get(PRIVATE_PROJECT_ID)).toBeUndefined();
    expect(broadcast).not.toHaveBeenCalledWith({
      type: 'kanban_update',
      projectId: PRIVATE_PROJECT_ID,
    });
  });

  it('appends promoted cards to the target column position order', async () => {
    const first = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'First promoted' })
      .expect(201);
    const second = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Second promoted' })
      .expect(201);

    const firstPromote = await request(mount(userA))
      .post(`/api/me/todos/${first.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);
    const secondPromote = await request(mount(userA))
      .post(`/api/me/todos/${second.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);

    expect(firstPromote.body.card.position).toBe(0);
    expect(secondPromote.body.card.position).toBe(1);
  });

  it('returns the existing linked card when promote is retried', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Retry-safe promote' })
      .expect(201);

    const first = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);
    const retry = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(200);

    expect(retry.body.card.id).toBe(first.body.card.id);
    expect(retry.body.todo.linkedId).toBe(first.body.card.id);
    const board = getOrCreateBoard(getStmts(), PROJECT_ID);
    const cards = getStmts().getKanbanCards.all(board.board.id) as Array<{ id: string }>;
    expect(cards.filter((card) => card.id === first.body.card.id)).toHaveLength(1);
    expect(cards).toHaveLength(1);
  });

  it('rejects an ordinary same-project card link that is not a prior promotion', async () => {
    const board = getOrCreateBoard(getStmts(), PROJECT_ID);
    const column = board.columns[0];
    const cardId = 'ordinary-linked-card';
    getStmts().createKanbanCard.run(
      cardId,
      column.id,
      board.board.id,
      'Ordinary linked card',
      null,
      'medium',
      null,
      null,
      null,
      null,
      userA,
      null,
      0,
    );
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({
        title: 'Promote should not reuse ordinary link',
        linkedType: 'card',
        linkedId: cardId,
        linkedProjectId: PROJECT_ID,
      })
      .expect(201);

    await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(409);

    const card = getStmts().getKanbanCard.get(cardId) as { source_type: string | null };
    expect(card.source_type).toBeNull();
  });

  it('recovers a same-project promoted todo whose linked card row is missing', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Recover missing card' })
      .expect(201);
    const cardId = `todo-${created.body.todo.id}`;
    setTodoLink(userA, created.body.todo.id, {
      type: 'card',
      id: cardId,
      projectId: PROJECT_ID,
    });

    const recovered = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);

    expect(recovered.body.todo.linkedId).toBe(cardId);
    expect(recovered.body.card).toMatchObject({
      id: cardId,
      title: 'Recover missing card',
      source_type: 'todo',
      source_id: created.body.todo.id,
    });
  });

  it('rejects a missing ordinary same-project card link instead of promoting it', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({
        title: 'Missing ordinary link',
        linkedType: 'card',
        linkedId: 'missing-ordinary-card',
        linkedProjectId: PROJECT_ID,
      })
      .expect(201);

    await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(409);
  });

  it('rejects stale deterministic recovered cards from another board', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Stale recovered card' })
      .expect(201);
    const todoId = created.body.todo.id as string;
    const cardId = `todo-${todoId}`;
    const oldBoard = getOrCreateBoard(getStmts(), 'old-todo-promote-project');
    const oldColumn = oldBoard.columns[0];
    getStmts().createKanbanCard.run(
      cardId,
      oldColumn.id,
      oldBoard.board.id,
      'Old promoted card',
      null,
      'medium',
      null,
      null,
      null,
      null,
      userA,
      null,
      0,
    );
    setTodoLink(userA, todoId, { type: 'card', id: cardId, projectId: PROJECT_ID });

    await request(mount(userA))
      .post(`/api/me/todos/${todoId}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(409);
  });

  it('rejects promoting a todo already linked to a different card', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({
        title: 'Already linked elsewhere',
        linkedType: 'card',
        linkedId: 'existing-card-id',
        linkedProjectId: 'other-project',
      })
      .expect(201);

    await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(409);
  });

  it('marks the todo done when the user preference enables auto-complete-on-promote', async () => {
    getOrgsDb()
      .prepare('UPDATE users SET preferences_json = ? WHERE id = ?')
      .run(JSON.stringify({ todoAutoCompleteOnPromote: true }), userA);
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Complete me on promote' })
      .expect(201);

    const res = await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(201);

    expect(res.body.todo).toMatchObject({ status: 'done', linkedType: 'card' });
  });

  it('keeps foreign todos private and rejects unknown targets', async () => {
    const created = await request(mount(userA))
      .post('/api/me/todos')
      .send({ title: 'Private promote' })
      .expect(201);

    await request(mount(userB))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(404);

    await request(mount(userA))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: 'missing-project' })
      .expect(404);
  });

  it('returns a controlled error when kanban deps are not mounted', async () => {
    const deps = { broadcast } as unknown as RouteDeps;
    const created = await request(mountWithDeps(userA, deps))
      .post('/api/me/todos')
      .send({ title: 'No kanban deps' })
      .expect(201);

    await request(mountWithDeps(userA, deps))
      .post(`/api/me/todos/${created.body.todo.id}/promote`)
      .send({ projectId: PROJECT_ID })
      .expect(500);
  });
});

describe('POST /api/me/todos/reorder', () => {
  it("reorders the caller's todos and ignores foreign ids", async () => {
    const t1 = (await request(mount(userA)).post('/api/me/todos').send({ title: 't1' })).body.todo;
    const t2 = (await request(mount(userA)).post('/api/me/todos').send({ title: 't2' })).body.todo;
    const bTodo = (await request(mount(userB)).post('/api/me/todos').send({ title: 'b' })).body
      .todo;
    broadcast.mockClear();

    const res = await request(mount(userA))
      .post('/api/me/todos/reorder')
      .send({ orderedIds: [t2.id, bTodo.id, t1.id] }) // bTodo is not A's — ignored
      .expect(200);

    expect(res.body.todos.map((t: { title: string }) => t.title)).toEqual(['t2', 't1']);
    // User B's list is untouched by A's reorder.
    expect(listTodos(userB).map((t) => t.title)).toEqual(['b']);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'user_todo_update',
        ownerUserId: userA,
        action: 'reordered',
      }),
    );
  });

  it('rejects a non-array orderedIds with 400', async () => {
    await request(mount(userA))
      .post('/api/me/todos/reorder')
      .send({ orderedIds: 'nope' })
      .expect(400);
  });
});

describe('user_todo_update broadcast delivery (broadcast-filter)', () => {
  const deps = {
    resolveProjectId: () => null,
    findProject: () => null,
  };

  it('delivers only to the owner, not to other users or org Owners', () => {
    const event = { type: 'user_todo_update', ownerUserId: userA, action: 'created' };

    // Owner of the todo sees it.
    expect(
      shouldDeliverBroadcast(event, { userId: userA, role: 'User', localBypass: false }, deps),
    ).toBe(true);

    // A different user does NOT see it.
    expect(
      shouldDeliverBroadcast(event, { userId: userB, role: 'User', localBypass: false }, deps),
    ).toBe(false);

    // An org Owner who is not the todo owner does NOT see it (no admin override).
    expect(
      shouldDeliverBroadcast(
        event,
        { userId: 'someone-else', role: 'Owner', localBypass: false },
        deps,
      ),
    ).toBe(false);
  });

  it('falls back to fan-out when ownerUserId is missing', () => {
    const event = { type: 'user_todo_update', action: 'created' };
    expect(
      shouldDeliverBroadcast(event, { userId: userB, role: 'User', localBypass: false }, deps),
    ).toBe(true);
  });
});
