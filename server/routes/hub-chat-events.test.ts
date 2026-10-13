/**
 * Live fan-out for `/api/chat/*`: every mutation broadcasts a chat event whose
 * `recipientUserIds` are the channel members, and the WS filter delivers it to
 * those users only. Read events go to the reader alone, so their other clients
 * clear unread.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { RouteDeps } from '../types.js';
import { shouldDeliverBroadcast } from '../broadcast-filter.js';
import type { WsVisibilityStamp } from '../session-ownership.js';

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');
const { chatPushUserIdsFromStore } = await import('../push.js');

type Event = Record<string, unknown> & { type: string; recipientUserIds: string[] };
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

/** Runs an event through the real WS filter for a user's connection. */
function delivered(e: Event, userId: string, role: WsVisibilityStamp['role'] = 'User'): boolean {
  return shouldDeliverBroadcast(e, { userId, role, localBypass: false } as WsVisibilityStamp, {
    resolveProjectId: () => null,
    findProject: () => null,
    getSessionOwner: () => null,
  });
}

let alice = '';
let bob = '';
let carol = '';

beforeEach(() => {
  events = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-events-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'Owner');
  createMembership(bob, 'acme', 'User');
  createMembership(carol, 'acme', 'User');
});

async function privateChannel(): Promise<string> {
  const res = await request(as(alice))
    .post('/api/chat/channels')
    .send({ name: 'secret', isPrivate: true, memberUserIds: [bob] })
    .expect(201);
  return res.body.channel.id;
}

describe('chat WS fan-out', () => {
  it('delivers a new message to members only, never to a non-member or an org Owner outsider', async () => {
    const id = await privateChannel();
    events = [];
    await request(as(bob))
      .post(`/api/chat/channels/${id}/messages`)
      .send({ body: 'hi' })
      .expect(201);
    const msg = events.find((e) => e.type === 'hub_chat_message')!;
    expect(msg.recipientUserIds).toEqual([alice, bob].sort());
    expect(msg.channelId).toBe(id);
    expect((msg.message as { body: string }).body).toBe('hi');
    expect(msg.authorName).toBe('bob');
    expect(delivered(msg, alice)).toBe(true);
    expect(delivered(msg, carol)).toBe(false);
    expect(delivered(msg, carol, 'Owner')).toBe(false);
  });

  it('sends edits and deletes to members only', async () => {
    const id = await privateChannel();
    const posted = await request(as(alice))
      .post(`/api/chat/channels/${id}/messages`)
      .send({ body: 'v1' });
    const mid = posted.body.message.id;
    events = [];
    await request(as(alice)).patch(`/api/chat/messages/${mid}`).send({ body: 'v2' }).expect(200);
    await request(as(alice)).delete(`/api/chat/messages/${mid}`).expect(200);
    const updates = events.filter((e) => e.type === 'hub_chat_message_update');
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.recipientUserIds).toEqual([alice, bob].sort());
      expect(delivered(u, carol)).toBe(false);
    }
    expect((updates[1].message as { deletedAt: string | null }).deletedAt).toBeTruthy();
  });

  it('sends read state to the reader alone so their other clients clear unread', async () => {
    const id = await privateChannel();
    await request(as(alice)).post(`/api/chat/channels/${id}/messages`).send({ body: 'one' });
    events = [];
    const res = await request(as(bob)).post(`/api/chat/channels/${id}/read`).send({}).expect(200);
    const read = events.find((e) => e.type === 'hub_chat_read')!;
    expect(read.recipientUserIds).toEqual([bob]);
    expect(read.lastReadSeq).toBe(res.body.lastReadSeq);
    expect(read.lastReadSeq).toBe(1);
    expect(delivered(read, alice)).toBe(false);
  });

  it('tells the removed member about their removal and keeps prefs private', async () => {
    const id = await privateChannel();
    events = [];
    await request(as(alice)).delete(`/api/chat/channels/${id}/members/${bob}`).expect(200);
    const removed = events.find((e) => e.type === 'hub_chat_channel_update')!;
    expect(removed.reason).toBe('member_removed');
    expect(removed.recipientUserIds).toEqual([alice, bob].sort());

    events = [];
    await request(as(alice))
      .put(`/api/chat/channels/${id}/mute`)
      .send({ mutedUntil: '2999-01-01T00:00:00Z' })
      .expect(200);
    const mute = events.find((e) => e.type === 'hub_chat_channel_update')!;
    expect(mute.reason).toBe('membership');
    expect(mute.recipientUserIds).toEqual([alice]);
  });

  it('announces a new DM to both parties only', async () => {
    await request(as(alice)).post('/api/chat/dms').send({ userId: bob }).expect(201);
    const created = events.find((e) => e.type === 'hub_chat_channel_update')!;
    expect(created.reason).toBe('created');
    expect(created.recipientUserIds).toEqual([alice, bob].sort());
    events = [];
    await request(as(alice)).post('/api/chat/dms').send({ userId: bob }).expect(200);
    expect(events).toHaveLength(0);
  });

  it('resolves push targets from live membership: a DM pushes, a muted DM does not', async () => {
    const dm = await request(as(alice)).post('/api/chat/dms').send({ userId: bob }).expect(201);
    const id = dm.body.channel.id;
    events = [];
    await request(as(alice)).post(`/api/chat/channels/${id}/messages`).send({ body: 'ping' });
    const first = events.find((e) => e.type === 'hub_chat_message')!;
    expect(chatPushUserIdsFromStore(first)).toEqual([bob]);

    await request(as(bob))
      .put(`/api/chat/channels/${id}/mute`)
      .send({ mutedUntil: '2999-01-01T00:00:00Z' })
      .expect(200);
    events = [];
    await request(as(alice)).post(`/api/chat/channels/${id}/messages`).send({ body: 'again' });
    const second = events.find((e) => e.type === 'hub_chat_message')!;
    expect(chatPushUserIdsFromStore(second)).toEqual([]);
  });

  it('denies a chat event with no recipient list', () => {
    expect(delivered({ type: 'hub_chat_message' } as unknown as Event, alice)).toBe(false);
  });
});
