/**
 * Hub Chat into the bell inbox, end to end through the real chat routes,
 * fan-out and stores: DMs and mentions create rows only for members
 * `chatPushRecipients` would notify, channel traffic creates none, and
 * marking the chat read clears the matching rows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');
const { handleBroadcastForNotifications } = await import('../notification-fanout.js');
const { listNotifications, countUnreadNotifications } = await import('../notifications-store.js');

type Event = Record<string, unknown> & { type: string };
let events: Event[] = [];

function as(userId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    areq.authUserId = userId;
    areq.authUser = 'x';
    areq.authRole = 'User';
    areq.authOrgId = 'acme';
    next();
  });
  const broadcast = (e: Record<string, unknown>) => events.push(e as Event);
  app.use(createHubChatRoutes({ stmts: {}, broadcast } as unknown as RouteDeps));
  return app;
}

/** Posts as `userId` and runs the resulting broadcast through the fan-out. */
async function post(userId: string, channelId: string, body: string): Promise<string> {
  events = [];
  const res = await request(as(userId))
    .post(`/api/chat/channels/${channelId}/messages`)
    .send({ body })
    .expect(201);
  const msg = events.find((e) => e.type === 'hub_chat_message');
  expect(msg).toBeTruthy();
  await handleBroadcastForNotifications(msg!, { getAllTokens: () => [], log: () => {} });
  return res.body.message.id;
}

const rows = (userId: string) => listNotifications(userId, { limit: 100 }).items;

let alice = '';
let bob = '';

beforeEach(() => {
  events = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-inbox-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'Owner');
  createMembership(bob, 'acme', 'User');
});

async function dm(): Promise<string> {
  const res = await request(as(alice)).post('/api/chat/dms').send({ userId: bob });
  return res.body.channel.id;
}

async function channel(): Promise<string> {
  const res = await request(as(alice))
    .post('/api/chat/channels')
    .send({ name: 'general', isPrivate: true, memberUserIds: [bob] })
    .expect(201);
  return res.body.channel.id;
}

describe('Hub Chat inbox rows', () => {
  it('creates a dm row for the recipient and none for the author', async () => {
    const id = await dm();
    const mid = await post(alice, id, 'hey');
    expect(rows(bob).map((n) => [n.category, n.sourceKey])).toEqual([['dm', `hub_chat:${mid}`]]);
    expect(rows(alice)).toEqual([]);
  });

  it('creates a mention row only for the mentioned user; plain channel traffic creates none', async () => {
    const id = await channel();
    await request(as(bob))
      .put(`/api/chat/channels/${id}/notify-level`)
      .send({ notifyLevel: 'all' })
      .expect(200);
    await post(alice, id, 'plain update');
    expect(rows(bob)).toEqual([]);
    const mid = await post(alice, id, `ping @[bob](user:${bob})`);
    expect(rows(bob).map((n) => [n.category, n.sourceKey])).toEqual([
      ['mention', `hub_chat:${mid}`],
    ]);
  });

  it('creates no row while the recipient has the channel muted', async () => {
    const id = await dm();
    await request(as(bob))
      .put(`/api/chat/channels/${id}/mute`)
      .send({ mutedUntil: '2999-01-01T00:00:00Z' })
      .expect(200);
    await post(alice, id, 'hey');
    expect(rows(bob)).toEqual([]);
  });

  it('creates no row at notify_level none, even for a mention', async () => {
    const id = await channel();
    await request(as(bob))
      .put(`/api/chat/channels/${id}/notify-level`)
      .send({ notifyLevel: 'none' })
      .expect(200);
    await post(alice, id, `ping @[bob](user:${bob})`);
    expect(rows(bob)).toEqual([]);
  });
});

describe('chat read marks inbox rows read', () => {
  it('marks rows up to the read pointer and tells the reader', async () => {
    const id = await dm();
    const first = await post(alice, id, 'one');
    const second = await post(alice, id, 'two');
    expect(countUnreadNotifications(bob)).toBe(2);

    events = [];
    await request(as(bob)).post(`/api/chat/channels/${id}/read`).send({ seq: 1 }).expect(200);
    const unread = rows(bob).filter((n) => !n.readAt);
    expect(unread.map((n) => n.sourceKey)).toEqual([`hub_chat:${second}`]);
    const ev = events.find((e) => e.type === 'notification_read')!;
    expect(ev.ownerUserId).toBe(bob);
    expect(ev.ids).toEqual(
      rows(bob)
        .filter((n) => n.sourceKey === `hub_chat:${first}`)
        .map((n) => n.id),
    );
    expect(ev.unreadCount).toBe(1);

    events = [];
    await request(as(bob)).post(`/api/chat/channels/${id}/read`).send({}).expect(200);
    expect(countUnreadNotifications(bob)).toBe(0);
    expect(events.filter((e) => e.type === 'notification_read')).toHaveLength(1);

    events = [];
    await request(as(bob)).post(`/api/chat/channels/${id}/read`).send({}).expect(200);
    expect(events.filter((e) => e.type === 'notification_read')).toHaveLength(0);
  });

  it('leaves rows from another channel unread', async () => {
    const d = await dm();
    const c = await channel();
    await post(alice, d, 'dm');
    await post(alice, c, `ping @[bob](user:${bob})`);
    await request(as(bob)).post(`/api/chat/channels/${c}/read`).send({}).expect(200);
    expect(
      rows(bob)
        .filter((n) => !n.readAt)
        .map((n) => n.category),
    ).toEqual(['dm']);
  });
});
