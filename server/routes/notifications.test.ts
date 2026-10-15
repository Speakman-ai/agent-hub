/**
 * Integration tests for the bell inbox REST surface (`/api/notifications`):
 * caller scoping (foreign ids 404), cursor paging with the unread filter, and
 * the owner-only `notification_read` broadcast on reads.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { insertNotification } = await import('../notifications-store.js');
const { default: createNotificationsRoutes } = await import('./notifications.js');
const { shouldDeliverBroadcast } = await import('../broadcast-filter.js');

const broadcast = vi.fn();

function mount(authUserId: string | null): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (authUserId) Object.assign(req, { authUserId, authUser: 'x', authRole: 'User' });
    next();
  });
  app.use(createNotificationsRoutes({ broadcast } as unknown as RouteDeps));
  return app;
}

let userA = '';
let userB = '';

function seed(userId: string, n: number, startMs = Date.UTC(2026, 9, 1)): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      insertNotification({
        userId,
        category: 'dm',
        title: `n${i}`,
        sourceKey: `src-${i}`,
        now: new Date(startMs + i * 1000),
      }).notification.id,
    );
  }
  return ids;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'notifications-route-'));
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  userA = createUser({ username: 'user-a', passwordHash: 'x' }).id;
  userB = createUser({ username: 'user-b', passwordHash: 'x' }).id;
  broadcast.mockClear();
});

describe('auth', () => {
  it('returns 401 on every route without a user', async () => {
    const app = mount(null);
    await request(app).get('/api/notifications').expect(401);
    await request(app).get('/api/notifications/unread-count').expect(401);
    await request(app).post('/api/notifications/read-all').expect(401);
    await request(app).post('/api/notifications/x/read').expect(401);
  });
});

describe('GET /api/notifications', () => {
  it('pages newest first with a cursor and only returns the caller rows', async () => {
    const ids = seed(userA, 5);
    seed(userB, 3);
    const app = mount(userA);

    const p1 = await request(app).get('/api/notifications?limit=2').expect(200);
    expect(p1.body.items.map((n: { id: string }) => n.id)).toEqual([ids[4], ids[3]]);
    expect(p1.body.nextCursor).toEqual(expect.any(String));

    const p2 = await request(app)
      .get('/api/notifications')
      .query({ limit: 2, cursor: p1.body.nextCursor })
      .expect(200);
    expect(p2.body.items.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[1]]);

    const p3 = await request(app)
      .get('/api/notifications')
      .query({ limit: 2, cursor: p2.body.nextCursor })
      .expect(200);
    expect(p3.body.items.map((n: { id: string }) => n.id)).toEqual([ids[0]]);
    expect(p3.body.nextCursor).toBeNull();
  });

  it('filters to unread rows with ?unread=true', async () => {
    const ids = seed(userA, 3);
    await request(mount(userA)).post(`/api/notifications/${ids[1]}/read`).expect(200);
    const res = await request(mount(userA)).get('/api/notifications?unread=true').expect(200);
    expect(res.body.items.map((n: { id: string }) => n.id)).toEqual([ids[2], ids[0]]);
    const all = await request(mount(userA)).get('/api/notifications?unread=false').expect(200);
    expect(all.body.items).toHaveLength(3);
  });

  it('rejects an out-of-range limit or bad unread flag with 400', async () => {
    await request(mount(userA)).get('/api/notifications?limit=0').expect(400);
    await request(mount(userA)).get('/api/notifications?limit=500').expect(400);
    await request(mount(userA)).get('/api/notifications?unread=maybe').expect(400);
  });
});

describe('GET /api/notifications/unread-count', () => {
  it('counts only the caller unread rows', async () => {
    seed(userA, 4);
    seed(userB, 2);
    const res = await request(mount(userA)).get('/api/notifications/unread-count').expect(200);
    expect(res.body).toEqual({ count: 4 });
  });
});

describe('POST /api/notifications/:id/read', () => {
  it('marks read, returns the new unread count, and broadcasts owner-only', async () => {
    const ids = seed(userA, 2);
    const res = await request(mount(userA)).post(`/api/notifications/${ids[0]}/read`).expect(200);
    expect(res.body.notification).toMatchObject({ id: ids[0], userId: userA });
    expect(res.body.notification.readAt).toEqual(expect.any(String));
    expect(res.body.unreadCount).toBe(1);

    expect(broadcast).toHaveBeenCalledTimes(1);
    const event = broadcast.mock.calls[0][0];
    expect(event).toMatchObject({
      type: 'notification_read',
      ownerUserId: userA,
      ids: [ids[0]],
      unreadCount: 1,
    });

    const deps = { getSessionOwner: () => null } as never;
    expect(shouldDeliverBroadcast(event, { userId: userA } as never, deps)).toBe(true);
    expect(shouldDeliverBroadcast(event, { userId: userB } as never, deps)).toBe(false);
    const ownerless = { ...event, ownerUserId: undefined };
    expect(shouldDeliverBroadcast(ownerless, { userId: userB } as never, deps)).toBe(false);
  });

  it('is idempotent and does not re-broadcast an already-read row', async () => {
    const [id] = seed(userA, 1);
    await request(mount(userA)).post(`/api/notifications/${id}/read`).expect(200);
    broadcast.mockClear();
    const res = await request(mount(userA)).post(`/api/notifications/${id}/read`).expect(200);
    expect(res.body.unreadCount).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("returns 404 for another user's row and leaves it unread", async () => {
    const [foreign] = seed(userB, 1);
    await request(mount(userA)).post(`/api/notifications/${foreign}/read`).expect(404);
    await request(mount(userA)).post('/api/notifications/missing/read').expect(404);
    expect(broadcast).not.toHaveBeenCalled();
    const res = await request(mount(userB)).get('/api/notifications/unread-count').expect(200);
    expect(res.body.count).toBe(1);
  });
});

describe('POST /api/notifications/read-all', () => {
  it("marks only the caller's rows read and broadcasts once", async () => {
    seed(userA, 3);
    seed(userB, 2);
    const res = await request(mount(userA)).post('/api/notifications/read-all').expect(200);
    expect(res.body).toEqual({ updated: 3, unreadCount: 0 });
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toMatchObject({
      type: 'notification_read',
      ownerUserId: userA,
      all: true,
      unreadCount: 0,
    });
    const b = await request(mount(userB)).get('/api/notifications/unread-count').expect(200);
    expect(b.body.count).toBe(2);
  });

  it('does not broadcast when nothing was unread', async () => {
    const res = await request(mount(userA)).post('/api/notifications/read-all').expect(200);
    expect(res.body).toEqual({ updated: 0, unreadCount: 0 });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
