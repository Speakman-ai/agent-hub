/**
 * Reactions and pins on `/api/chat/*`: only channel members can react or pin,
 * every change reaches members as one `hub_chat_message_meta` event carrying
 * the full state, and deleting a message clears both.
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
const { EmojiSchema } = await import('./hub-chat.openapi.js');

type Event = Record<string, unknown> & { type: string; recipientUserIds?: string[] };
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
  app.use(
    createHubChatRoutes({
      stmts: {},
      broadcast: (e: Event) => events.push(e),
    } as unknown as RouteDeps),
  );
  return app;
}

let alice = '';
let bob = '';
let carol = '';
let channelId = '';
let messageId = '';

beforeEach(() => {
  events = [];
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-reactions-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  for (const u of [alice, bob, carol]) createMembership(u, 'acme', 'User');
  channelId = store.createChannel({
    orgId: 'acme',
    kind: 'channel',
    name: 'general',
    createdByUserId: alice,
    memberUserIds: [bob],
  }).id;
  messageId = store.appendMessage({
    channelId,
    authorKind: 'user',
    authorUserId: alice,
    body: 'ship it',
  }).id;
});

const metaEvents = () => events.filter((e) => e.type === 'hub_chat_message_meta');

describe('emoji validation', () => {
  it('accepts exactly one emoji sequence', () => {
    const one = ['👍', '❤️', '👍🏽', '👨‍👩‍👧', '🧑🏽‍💻', '❤️‍🔥', '1️⃣', '#️⃣', '🇺🇸', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '✅'];
    for (const e of one) expect(EmojiSchema.safeParse(e).success, e).toBe(true);
  });

  it('rejects concatenated emoji and stray components', () => {
    const bad = [
      '👍👍',
      '👍123',
      '👍🏽🏽',
      '🇺',
      '🇺🇸🇺🇸',
      '🏽',
      '\u200d',
      '👍\u200d',
      '1',
      '#',
      'lol',
      'hi👍',
    ];
    for (const e of bad) expect(EmojiSchema.safeParse(e).success, JSON.stringify(e)).toBe(false);
  });
});

describe('reactions', () => {
  it('adds, groups and removes reactions and syncs each change live', async () => {
    const first = await request(as(bob))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '👍' })
      .expect(200);
    expect(first.body.meta.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [bob] }]);
    await request(as(alice))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '👍' })
      .expect(200);
    await request(as(alice))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '🎉' })
      .expect(200);

    const evs = metaEvents();
    expect(evs).toHaveLength(3);
    expect(evs[2]).toMatchObject({
      channelId,
      messageId,
      recipientUserIds: [alice, bob].sort(),
      reactions: [
        { emoji: '👍', count: 2, userIds: [bob, alice] },
        { emoji: '🎉', count: 1, userIds: [alice] },
      ],
    });
    // Revisions only move forward, so clients can drop stale copies.
    const revs = evs.map((e) => e.metaRev as number);
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(3);

    // The message itself carries the same state when paged.
    const page = await request(as(bob)).get(`/api/chat/channels/${channelId}/messages`).expect(200);
    expect(page.body.messages[0].reactions).toHaveLength(2);
    expect(page.body.messages[0].metaRev).toBe(revs[2]);

    const removed = await request(as(bob))
      .delete(`/api/chat/messages/${messageId}/reactions`)
      .query({ emoji: '👍' })
      .expect(200);
    expect(removed.body.meta.reactions[0]).toEqual({ emoji: '👍', count: 1, userIds: [alice] });
    expect(metaEvents()).toHaveLength(4);
  });

  it('does not broadcast a reaction that changed nothing', async () => {
    const app = as(bob);
    await request(app).put(`/api/chat/messages/${messageId}/reactions`).send({ emoji: '👀' });
    await request(app).put(`/api/chat/messages/${messageId}/reactions`).send({ emoji: '👀' });
    await request(app)
      .delete(`/api/chat/messages/${messageId}/reactions`)
      .query({ emoji: '🎉' })
      .expect(200);
    expect(metaEvents()).toHaveLength(1);
  });

  it('rejects non-emoji and non-members', async () => {
    await request(as(bob))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: 'lol' })
      .expect(400);
    // Carol can read the public channel but has not joined it.
    const res = await request(as(carol))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '👍' })
      .expect(409);
    expect(res.body.code).toBe('not_joined');
    expect(metaEvents()).toHaveLength(0);
  });

  it('caps the distinct emoji on one message', async () => {
    const pool = ['😀', '😁', '😂', '🤣', '😃', '😄', '😅', '😆', '😉', '😊'];
    pool.push('😋', '😎', '😍', '😘', '🥰', '😗', '😙', '😚', '🙂', '🤗');
    for (const emoji of pool) {
      await request(as(bob))
        .put(`/api/chat/messages/${messageId}/reactions`)
        .send({ emoji })
        .expect(200);
    }
    const res = await request(as(bob))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '🤩' })
      .expect(400);
    expect(res.body.code).toBe('too_many_reactions');
    // Joining an existing emoji is still allowed.
    await request(as(alice))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '😀' })
      .expect(200);
  });
});

describe('pins', () => {
  it('pins and unpins, lists pins newest first, and tells members', async () => {
    const second = store.appendMessage({
      channelId,
      authorKind: 'user',
      authorUserId: bob,
      body: 'runbook link',
    });
    await request(as(bob)).put(`/api/chat/messages/${messageId}/pin`).expect(200);
    const pinned = await request(as(alice)).put(`/api/chat/messages/${second.id}/pin`).expect(200);
    expect(pinned.body.meta.pinned).toMatchObject({ byUserId: alice });

    // Public channel: a reader who has not joined can still see the list.
    const list = await request(as(carol)).get(`/api/chat/channels/${channelId}/pins`).expect(200);
    expect(list.body.pins.map((p: { message: { id: string } }) => p.message.id)).toEqual([
      second.id,
      messageId,
    ]);
    expect(list.body.pins[1].pinnedByUserId).toBe(bob);
    expect(metaEvents().every((e) => e.pinChanged === true)).toBe(true);
    expect(metaEvents()).toHaveLength(2);

    await request(as(alice)).delete(`/api/chat/messages/${messageId}/pin`).expect(200);
    const after = await request(as(alice)).get(`/api/chat/channels/${channelId}/pins`).expect(200);
    expect(after.body.pins).toHaveLength(1);
    expect(metaEvents()).toHaveLength(3);
  });

  it('drops reactions and the pin when the message is deleted', async () => {
    await request(as(bob)).put(`/api/chat/messages/${messageId}/pin`).expect(200);
    await request(as(bob))
      .put(`/api/chat/messages/${messageId}/reactions`)
      .send({ emoji: '👍' })
      .expect(200);
    events = [];
    await request(as(alice)).delete(`/api/chat/messages/${messageId}`).expect(200);
    const [ev] = metaEvents();
    expect(ev).toMatchObject({ messageId, reactions: [], pinned: null, pinChanged: true });
    const list = await request(as(alice)).get(`/api/chat/channels/${channelId}/pins`).expect(200);
    expect(list.body.pins).toEqual([]);
    await request(as(bob)).put(`/api/chat/messages/${messageId}/pin`).expect(404);
  });

  it('refuses pins in an archived channel', async () => {
    store.archiveChannel(channelId);
    const res = await request(as(bob)).put(`/api/chat/messages/${messageId}/pin`).expect(409);
    expect(res.body.code).toBe('channel_archived');
  });
});
