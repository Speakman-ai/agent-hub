/**
 * Integration tests for the Agent Hub chat REST surface (`/api/chat/*`):
 * org + channel visibility, seq pagination, author-only edit/delete, and the
 * per-member read / notify / mute state.
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
const store = await import('../hub-chat-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');

interface Claims {
  userId?: string;
  orgId?: string;
}

function as(claims: Claims): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    if (claims.userId) {
      areq.authUserId = claims.userId;
      areq.authUser = 'x';
      areq.authRole = 'User';
    }
    areq.authOrgId = claims.orgId ?? 'acme';
    next();
  });
  app.use(createHubChatRoutes({ stmts: {} } as unknown as RouteDeps));
  return app;
}

let alice = '';
let bob = '';
let carol = '';
let mallory = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-route-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  createOrg({ id: 'other', name: 'Other', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  mallory = createUser({ username: 'mallory', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  createMembership(carol, 'acme', 'User');
  createMembership(mallory, 'other', 'User');
});

async function makeChannel(
  owner: string,
  body: Record<string, unknown>,
): Promise<{ id: string } & Record<string, unknown>> {
  const res = await request(as({ userId: owner }))
    .post('/api/chat/channels')
    .send(body)
    .expect(201);
  return res.body.channel;
}

async function post(user: string, channelId: string, text: string) {
  return request(as({ userId: user }))
    .post(`/api/chat/channels/${channelId}/messages`)
    .send({ body: text });
}

describe('auth and org scoping', () => {
  it('401s without a user identity', async () => {
    await request(as({})).get('/api/chat/channels').expect(401);
  });

  it('403s a user who is not in the active org', async () => {
    await request(as({ userId: mallory }))
      .get('/api/chat/channels')
      .expect(403);
  });

  it('lists org members for the DM picker', async () => {
    const res = await request(as({ userId: alice }))
      .get('/api/chat/members')
      .expect(200);
    const names = res.body.members.map((m: { username: string }) => m.username).sort();
    expect(names).toEqual(['alice', 'bob', 'carol']);
  });

  it('hides a channel from another org as 404', async () => {
    const ch = await makeChannel(alice, { name: 'general' });
    await request(as({ userId: mallory, orgId: 'other' }))
      .get(`/api/chat/channels/${ch.id}`)
      .expect(404);
    await request(as({ userId: mallory, orgId: 'other' }))
      .get(`/api/chat/channels/${ch.id}/messages`)
      .expect(404);
  });
});

describe('private channels and DMs', () => {
  it('a non-member gets 404 on every private-channel route', async () => {
    const ch = await makeChannel(alice, { name: 'secret', isPrivate: true, memberUserIds: [bob] });
    const app = as({ userId: carol });
    await request(app).get(`/api/chat/channels/${ch.id}`).expect(404);
    await request(app).get(`/api/chat/channels/${ch.id}/messages`).expect(404);
    await request(app).post(`/api/chat/channels/${ch.id}/join`).expect(404);
    await request(app)
      .post(`/api/chat/channels/${ch.id}/messages`)
      .send({ body: 'hi' })
      .expect(404);
    await request(app).post(`/api/chat/channels/${ch.id}/read`).send({}).expect(404);

    const msg = (await post(bob, ch.id, 'members only')).body.message;
    await request(app).patch(`/api/chat/messages/${msg.id}`).send({ body: 'x' }).expect(404);
    await request(app).delete(`/api/chat/messages/${msg.id}`).expect(404);

    const browse = await request(app).get('/api/chat/channels/browse').expect(200);
    expect(browse.body.channels).toEqual([]);
  });

  it('opens one DM per pair and keeps a third user out', async () => {
    const first = await request(as({ userId: alice }))
      .post('/api/chat/dms')
      .send({ userId: bob })
      .expect(201);
    const again = await request(as({ userId: bob }))
      .post('/api/chat/dms')
      .send({ userId: alice })
      .expect(200);
    expect(again.body.channel.id).toBe(first.body.channel.id);
    expect(first.body.channel).toMatchObject({ kind: 'dm', isPrivate: true, dmPeerUserId: bob });
    expect(again.body.channel.dmPeerUserId).toBe(alice);

    await request(as({ userId: carol }))
      .get(`/api/chat/channels/${first.body.channel.id}/messages`)
      .expect(404);
    await request(as({ userId: alice }))
      .post(`/api/chat/channels/${first.body.channel.id}/members`)
      .send({ userIds: [carol] })
      .expect(400);
  });

  it('refuses a DM or invite with someone outside the org', async () => {
    await request(as({ userId: alice }))
      .post('/api/chat/dms')
      .send({ userId: mallory })
      .expect(400);
    await request(as({ userId: alice }))
      .post('/api/chat/channels')
      .send({ name: 'x', memberUserIds: [mallory] })
      .expect(400);
  });
});

describe('public channels', () => {
  it('can be browsed and read, but posting needs a join', async () => {
    const ch = await makeChannel(alice, { name: 'general', topic: 'all hands' });
    await post(alice, ch.id, 'welcome');

    const browse = await request(as({ userId: bob }))
      .get('/api/chat/channels/browse')
      .expect(200);
    expect(browse.body.channels.map((c: { id: string }) => c.id)).toEqual([ch.id]);
    expect(browse.body.channels[0].membership).toBeNull();

    const read = await request(as({ userId: bob }))
      .get(`/api/chat/channels/${ch.id}/messages`)
      .expect(200);
    expect(read.body.messages).toHaveLength(1);

    const refused = await post(bob, ch.id, 'hello');
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('not_joined');

    const joined = await request(as({ userId: bob }))
      .post(`/api/chat/channels/${ch.id}/join`)
      .expect(200);
    expect(joined.body.channel.membership).toMatchObject({ role: 'member', lastReadSeq: 1 });
    expect((await post(bob, ch.id, 'hello')).status).toBe(201);

    const mine = await request(as({ userId: bob }))
      .get('/api/chat/channels')
      .expect(200);
    expect(mine.body.channels.map((c: { id: string }) => c.id)).toEqual([ch.id]);
  });

  it('only owners remove others; anyone can leave', async () => {
    const ch = await makeChannel(alice, { name: 'team', memberUserIds: [bob, carol] });
    await request(as({ userId: bob }))
      .delete(`/api/chat/channels/${ch.id}/members/${carol}`)
      .expect(403);
    await request(as({ userId: bob }))
      .delete(`/api/chat/channels/${ch.id}/members/${bob}`)
      .expect(200);
    await request(as({ userId: alice }))
      .delete(`/api/chat/channels/${ch.id}/members/${carol}`)
      .expect(200);
    const detail = await request(as({ userId: alice }))
      .get(`/api/chat/channels/${ch.id}`)
      .expect(200);
    expect(detail.body.members.map((m: { username: string }) => m.username)).toEqual(['alice']);
  });

  it('rejects posts to an archived channel', async () => {
    const ch = await makeChannel(alice, { name: 'old' });
    store.archiveChannel(ch.id);
    expect((await post(alice, ch.id, 'late')).status).toBe(409);
  });
});

describe('message pagination', () => {
  it('pages back with before and forward with after, reporting hasMore', async () => {
    const ch = await makeChannel(alice, { name: 'busy' });
    for (let i = 1; i <= 7; i++) await post(alice, ch.id, `m${i}`);
    const app = as({ userId: alice });
    const url = `/api/chat/channels/${ch.id}/messages`;

    const latest = await request(app).get(url).query({ limit: 3 }).expect(200);
    expect(latest.body.messages.map((m: { seq: number }) => m.seq)).toEqual([5, 6, 7]);
    expect(latest.body.hasMore).toBe(true);

    const older = await request(app).get(url).query({ before: 5, limit: 3 }).expect(200);
    expect(older.body.messages.map((m: { seq: number }) => m.seq)).toEqual([2, 3, 4]);
    expect(older.body.hasMore).toBe(true);

    const oldest = await request(app).get(url).query({ before: 2, limit: 3 }).expect(200);
    expect(oldest.body.messages.map((m: { seq: number }) => m.seq)).toEqual([1]);
    expect(oldest.body.hasMore).toBe(false);

    const newer = await request(app).get(url).query({ after: 3, limit: 2 }).expect(200);
    expect(newer.body.messages.map((m: { seq: number }) => m.seq)).toEqual([4, 5]);
    expect(newer.body.hasMore).toBe(true);

    const tail = await request(app).get(url).query({ after: 5, limit: 5 }).expect(200);
    expect(tail.body.messages.map((m: { seq: number }) => m.seq)).toEqual([6, 7]);
    expect(tail.body.hasMore).toBe(false);
  });

  it('400s on bad paging input', async () => {
    const ch = await makeChannel(alice, { name: 'p' });
    const url = `/api/chat/channels/${ch.id}/messages`;
    await request(as({ userId: alice }))
      .get(url)
      .query({ before: 3, after: 1 })
      .expect(400);
    await request(as({ userId: alice }))
      .get(url)
      .query({ limit: 0 })
      .expect(400);
    await request(as({ userId: alice }))
      .get(url)
      .query({ limit: 'x' })
      .expect(400);
  });
});

describe('edit and delete', () => {
  it('lets the author edit and soft-delete, and nobody else', async () => {
    const ch = await makeChannel(alice, { name: 'edits', memberUserIds: [bob] });
    const msg = (await post(alice, ch.id, 'tpyo')).body.message;

    await request(as({ userId: bob }))
      .patch(`/api/chat/messages/${msg.id}`)
      .send({ body: 'hijack' })
      .expect(403);
    await request(as({ userId: bob }))
      .delete(`/api/chat/messages/${msg.id}`)
      .expect(403);

    const edited = await request(as({ userId: alice }))
      .patch(`/api/chat/messages/${msg.id}`)
      .send({ body: 'typo' })
      .expect(200);
    expect(edited.body.message.body).toBe('typo');
    expect(edited.body.message.editedAt).toBeTruthy();

    const deleted = await request(as({ userId: alice }))
      .delete(`/api/chat/messages/${msg.id}`)
      .expect(200);
    expect(deleted.body.message).toMatchObject({ body: '', seq: msg.seq });
    expect(deleted.body.message.deletedAt).toBeTruthy();

    await request(as({ userId: alice }))
      .patch(`/api/chat/messages/${msg.id}`)
      .send({ body: 'back' })
      .expect(404);
  });

  it('refuses edits of agent-authored messages', async () => {
    const ch = await makeChannel(alice, { name: 'bots' });
    const m = store.appendMessage({ channelId: ch.id, authorKind: 'agent', body: 'beep' });
    await request(as({ userId: alice }))
      .patch(`/api/chat/messages/${m.id}`)
      .send({ body: 'boop' })
      .expect(403);
  });

  it('rejects a blank body', async () => {
    const ch = await makeChannel(alice, { name: 'blank' });
    expect((await post(alice, ch.id, '   ')).status).toBe(400);
  });
});

describe('read state, notify level and mute', () => {
  it('reports unread counts and marks read', async () => {
    const ch = await makeChannel(alice, { name: 'unread', memberUserIds: [bob] });
    await post(alice, ch.id, 'one');
    await post(alice, ch.id, 'two');
    const app = as({ userId: bob });

    const before = await request(app).get('/api/chat/channels').expect(200);
    expect(before.body.channels[0]).toMatchObject({ unreadCount: 2, lastSeq: 2 });

    const marked = await request(app).post(`/api/chat/channels/${ch.id}/read`).send({ seq: 1 });
    expect(marked.body.lastReadSeq).toBe(1);
    const all = await request(app).post(`/api/chat/channels/${ch.id}/read`).send({});
    expect(all.body.lastReadSeq).toBe(2);

    const after = await request(app).get('/api/chat/channels').expect(200);
    expect(after.body.channels[0].unreadCount).toBe(0);
  });

  it('sets notify level and mute', async () => {
    const ch = await makeChannel(alice, { name: 'prefs' });
    const app = as({ userId: alice });
    const lvl = await request(app)
      .put(`/api/chat/channels/${ch.id}/notify-level`)
      .send({ notifyLevel: 'all' })
      .expect(200);
    expect(lvl.body.membership.notifyLevel).toBe('all');
    await request(app)
      .put(`/api/chat/channels/${ch.id}/notify-level`)
      .send({ notifyLevel: 'loud' })
      .expect(400);

    const muted = await request(app)
      .put(`/api/chat/channels/${ch.id}/mute`)
      .send({ mutedUntil: '2030-01-01T00:00:00Z' })
      .expect(200);
    expect(muted.body.membership.mutedUntil).toBe('2030-01-01T00:00:00.000Z');
    const unmuted = await request(app)
      .put(`/api/chat/channels/${ch.id}/mute`)
      .send({ mutedUntil: null })
      .expect(200);
    expect(unmuted.body.membership.mutedUntil).toBeNull();
    await request(app)
      .put(`/api/chat/channels/${ch.id}/mute`)
      .send({ mutedUntil: 'tomorrow' })
      .expect(400);
  });
});

describe('channel settings', () => {
  it('lets a member rename a channel and set or clear its topic', async () => {
    const ch = await makeChannel(alice, { name: 'general', memberUserIds: [bob] });
    const res = await request(as({ userId: bob }))
      .patch(`/api/chat/channels/${ch.id}`)
      .send({ name: 'lobby', topic: 'Say hi' })
      .expect(200);
    expect(res.body.channel).toMatchObject({ name: 'lobby', topic: 'Say hi' });
    const cleared = await request(as({ userId: alice }))
      .patch(`/api/chat/channels/${ch.id}`)
      .send({ topic: '' })
      .expect(200);
    expect(cleared.body.channel).toMatchObject({ name: 'lobby', topic: null });
  });

  it('refuses non-members, DMs and empty patches', async () => {
    const ch = await makeChannel(alice, { name: 'general' });
    await request(as({ userId: carol }))
      .patch(`/api/chat/channels/${ch.id}`)
      .send({ name: 'x' })
      .expect(409);
    await request(as({ userId: alice }))
      .patch(`/api/chat/channels/${ch.id}`)
      .send({})
      .expect(400);
    const dm = await request(as({ userId: alice }))
      .post('/api/chat/dms')
      .send({ userId: bob })
      .expect(201);
    await request(as({ userId: alice }))
      .patch(`/api/chat/channels/${dm.body.channel.id}`)
      .send({ name: 'x' })
      .expect(400);
  });

  it('returns the viewer id with the channel list', async () => {
    const res = await request(as({ userId: alice }))
      .get('/api/chat/channels')
      .expect(200);
    expect(res.body.viewerUserId).toBe(alice);
  });
});
