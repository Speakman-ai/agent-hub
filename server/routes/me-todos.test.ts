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
import type { RouteDeps } from '../types.js';

let TMP_DIR = '';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { listTodos } = await import('../user-todos-store.js');
const { default: createMeTodosRoutes } = await import('./me-todos.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');

const broadcast = vi.fn();

function makeDeps(): RouteDeps {
  return { broadcast } as unknown as RouteDeps;
}

/** Mount the router behind a middleware that stamps a fixed acting user. */
function mount(authUserId: string | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) {
      Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    }
    next();
  });
  app.use(createMeTodosRoutes(makeDeps()));
  return app;
}

let userA = '';
let userB = '';

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'me-todos-route-'));
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
