/**
 * Integration tests for the shared org-todos REST surface
 * (`/api/orgs/:orgId/todos`).
 *
 * Locks the invariants that make this a *shared* list with an *org* boundary:
 *   1. Any member of the org may read AND write the list (no per-user
 *      ownership) — unlike personal todos, user B sees the todo user A created.
 *   2. A non-member is refused (403); an unknown org 404s.
 *   3. Each write broadcasts an `org_todo_update` event stamped with the orgId,
 *      and the broadcast filter delivers it to members of that org only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

// Force `authIsConfigured()` true so the membership gate actually runs (the
// route reads getAuthRecord()). Without this, the no-auth dev bypass would wave
// every caller through and the 403 path could never be exercised.
vi.mock('../auth-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../auth-store.js')>();
  return {
    ...actual,
    getAuthRecord: () => ({
      username: 'owner',
      passwordHash: 'x',
      jwtSecret: 's',
      role: 'Owner',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  };
});

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { getMembershipRole } = await import('../memberships-store.js');
const { listOrgTodos } = await import('../org-todos-store.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');
const { default: createOrgTodosRoutes } = await import('./org-todos.js');

const broadcast = vi.fn();

function makeDeps(): RouteDeps {
  return { broadcast } as unknown as RouteDeps;
}

interface Claims {
  authUserId?: string;
  authViaApiKey?: boolean;
  authLocalOrgBypass?: boolean;
}

function mount(claims: Claims): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    if (claims.authUserId !== undefined) {
      areq.authUserId = claims.authUserId;
      areq.authUser = 'x';
      areq.authRole = 'User';
    }
    if (claims.authViaApiKey !== undefined) areq.authViaApiKey = claims.authViaApiKey;
    if (claims.authLocalOrgBypass !== undefined)
      areq.authLocalOrgBypass = claims.authLocalOrgBypass;
    next();
  });
  app.use(createOrgTodosRoutes(makeDeps()));
  return app;
}

let memberA = '';
let memberB = '';
let outsider = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'org-todos-route-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  // mode 'remote' so createOrg skips creating a real per-org data dir under HOME.
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  memberA = createUser({ username: 'member-a', passwordHash: 'x' }).id;
  memberB = createUser({ username: 'member-b', passwordHash: 'x' }).id;
  outsider = createUser({ username: 'outsider', passwordHash: 'x' }).id;
  createMembership(memberA, 'acme', 'User');
  createMembership(memberB, 'acme', 'User');
  broadcast.mockClear();
});

describe('POST /api/orgs/:orgId/todos', () => {
  it('creates a shared todo, records the creator, and broadcasts org_todo_update', async () => {
    const res = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: '  Team lunch  ', notes: 'friday', priority: 'high' })
      .expect(201);

    expect(res.body.todo).toMatchObject({
      orgId: 'acme',
      title: 'Team lunch',
      notes: 'friday',
      priority: 'high',
      status: 'open',
      position: 0,
      createdByUserId: memberA,
    });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'org_todo_update', orgId: 'acme', action: 'created' }),
    );
  });

  it('rejects an empty title with 400 and no broadcast', async () => {
    await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: '   ' })
      .expect(400);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses a non-member with 403', async () => {
    await request(mount({ authUserId: outsider }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'x' })
      .expect(403);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('404s an unknown org', async () => {
    await request(mount({ authUserId: memberA }))
      .post('/api/orgs/ghost/todos')
      .send({ title: 'x' })
      .expect(404);
  });

  it('lets the global apiKey break-glass create even without a membership', async () => {
    await request(mount({ authViaApiKey: true }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'from apikey' })
      .expect(201);
  });

  it("resolves the 'active' org alias to the server's active org", async () => {
    setActiveOrgId('acme');
    const res = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/active/todos')
      .send({ title: 'via active alias' })
      .expect(201);
    // The row lands in the concrete active org (acme), not a literal 'active'.
    expect(res.body.todo.orgId).toBe('acme');
    expect(listOrgTodos('acme').map((t) => t.title)).toContain('via active alias');
  });
});

describe('GET /api/orgs/:orgId/todos — the list is shared across members', () => {
  it('member B sees the todo member A created', async () => {
    await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'shared item' })
      .expect(201);

    const res = await request(mount({ authUserId: memberB }))
      .get('/api/orgs/acme/todos')
      .expect(200);
    expect(res.body.todos.map((t: { title: string }) => t.title)).toEqual(['shared item']);
  });

  it('filters by status', async () => {
    const created = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'to complete' });
    await request(mount({ authUserId: memberB }))
      .put(`/api/orgs/acme/todos/${created.body.todo.id}`)
      .send({ status: 'done' })
      .expect(200);

    const open = await request(mount({ authUserId: memberA }))
      .get('/api/orgs/acme/todos?status=open')
      .expect(200);
    expect(open.body.todos).toHaveLength(0);
    const done = await request(mount({ authUserId: memberA }))
      .get('/api/orgs/acme/todos?status=done')
      .expect(200);
    expect(done.body.todos).toHaveLength(1);
  });
});

describe('PUT / DELETE / reorder', () => {
  it('any member can edit and delete any todo (no per-user ownership)', async () => {
    const created = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'a-created' });
    const id = created.body.todo.id as string;

    // member B edits member A's todo.
    const edited = await request(mount({ authUserId: memberB }))
      .put(`/api/orgs/acme/todos/${id}`)
      .send({ title: 'b-edited' })
      .expect(200);
    expect(edited.body.todo.title).toBe('b-edited');

    // member B deletes it.
    await request(mount({ authUserId: memberB }))
      .delete(`/api/orgs/acme/todos/${id}`)
      .expect(200);
    expect(listOrgTodos('acme')).toHaveLength(0);
  });

  it('reorders the shared list and broadcasts', async () => {
    const one = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'one' });
    const two = await request(mount({ authUserId: memberA }))
      .post('/api/orgs/acme/todos')
      .send({ title: 'two' });
    broadcast.mockClear();

    const res = await request(mount({ authUserId: memberB }))
      .post('/api/orgs/acme/todos/reorder')
      .send({ orderedIds: [two.body.todo.id, one.body.todo.id] })
      .expect(200);
    expect(res.body.todos.map((t: { title: string }) => t.title)).toEqual(['two', 'one']);
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'org_todo_update', orgId: 'acme', action: 'reordered' }),
    );
  });
});

describe('broadcast filter — org_todo_update reaches org members only', () => {
  const isOrgMember = (userId: string, orgId: string) => getMembershipRole(userId, orgId) !== null;
  const filterDeps = {
    resolveProjectId: () => null,
    findProject: () => null,
    getSessionOwner: () => null,
    isOrgMember,
  };

  it('delivers to a member, denies a non-member, and honors localBypass', () => {
    const event = { type: 'org_todo_update', orgId: 'acme', action: 'created' };
    // Delivery keys off real membership rows created in the outer beforeEach.
    expect(getMembershipRole(memberA, 'acme')).not.toBeNull();
    expect(getMembershipRole(outsider, 'acme')).toBeNull();

    expect(shouldDeliverBroadcast(event, { userId: memberA, role: 'User' }, filterDeps)).toBe(true);
    expect(shouldDeliverBroadcast(event, { userId: outsider, role: 'User' }, filterDeps)).toBe(
      false,
    );
    // localBypass (apiKey / single-tenant) sees everything.
    expect(shouldDeliverBroadcast(event, { userId: null, localBypass: true }, filterDeps)).toBe(
      true,
    );
    // No stamp → legacy fan-out.
    expect(shouldDeliverBroadcast(event, undefined, filterDeps)).toBe(true);
  });
});
