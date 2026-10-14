/**
 * `GET /api/chat/search`: results are limited to channels the caller can read
 * (public channels in their org, private channels / groups / DMs they belong
 * to), and deleted or edited-away text is not found.
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

function as(userId: string | null, orgId = 'acme'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    if (userId) {
      areq.authUserId = userId;
      areq.authUser = 'x';
      areq.authRole = 'User';
    }
    areq.authOrgId = orgId;
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
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-search-'));
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

function say(channelId: string, userId: string, body: string) {
  return store.appendMessage({ channelId, authorKind: 'user', authorUserId: userId, body });
}

async function search(userId: string, q: string, extra: Record<string, string> = {}, org = 'acme') {
  const res = await request(as(userId, org))
    .get('/api/chat/search')
    .query({ q, ...extra })
    .expect(200);
  return res.body as {
    results: {
      message: { id: string; body: string };
      channel: { id: string; isMember: boolean };
    }[];
    hasMore: boolean;
  };
}

describe('GET /api/chat/search', () => {
  it('returns only messages from channels the caller can read', async () => {
    const pub = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'general',
      createdByUserId: alice,
    });
    const priv = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'secret',
      isPrivate: true,
      createdByUserId: alice,
      memberUserIds: [bob],
    });
    const dm = store.getOrCreateDm('acme', alice, bob).channel;
    const otherOrg = store.createChannel({
      orgId: 'other',
      kind: 'channel',
      name: 'x',
      createdByUserId: mallory,
    });
    const inPub = say(pub.id, alice, 'deploy the zebra build');
    const inPriv = say(priv.id, alice, 'zebra secret plans');
    const inDm = say(dm.id, bob, 'zebra in our DM');
    say(otherOrg.id, mallory, 'zebra elsewhere');

    const ids = async (user: string, org = 'acme') =>
      (await search(user, 'zebra', {}, org)).results.map((r) => r.message.id).sort();

    expect(await ids(alice)).toEqual([inPub.id, inPriv.id, inDm.id].sort());
    expect(await ids(bob)).toEqual([inPub.id, inPriv.id, inDm.id].sort());
    // Carol has joined nothing: only the public channel is readable.
    const carolRes = await search(carol, 'zebra');
    expect(carolRes.results.map((r) => r.message.id)).toEqual([inPub.id]);
    expect(carolRes.results[0]!.channel).toMatchObject({ id: pub.id, isMember: false });
    expect(await ids(mallory, 'other')).toHaveLength(1);
    // A channel filter cannot widen visibility.
    expect((await search(carol, 'zebra', { channelId: priv.id })).results).toEqual([]);
  });

  it('matches word prefixes, skips deleted messages and follows edits', async () => {
    const ch = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'g',
      createdByUserId: alice,
    });
    const kept = say(ch.id, alice, 'Migrations are running');
    const gone = say(ch.id, alice, 'migration rollback');
    const edited = say(ch.id, alice, 'migration typo');
    store.softDeleteMessage(gone.id);
    store.editMessage(edited.id, { body: 'nothing relevant' });

    const res = await search(alice, 'migr');
    expect(res.results.map((r) => r.message.id)).toEqual([kept.id]);
    expect((await search(alice, 'relevant')).results.map((r) => r.message.id)).toEqual([edited.id]);
  });

  it('treats FTS syntax as plain words and pages with hasMore', async () => {
    const ch = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'g',
      createdByUserId: alice,
    });
    for (let i = 0; i < 3; i++) say(ch.id, alice, `alpha AND "beta" ${i}`);
    expect((await search(alice, 'alpha" OR (NEAR')).results).toEqual([]);
    const page = await search(alice, 'alpha beta', { limit: '2' });
    expect(page.results).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    // Newest first.
    expect(page.results[0]!.message.body).toContain('2');
  });

  it('requires every word even past twelve terms', async () => {
    const ch = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'g',
      createdByUserId: alice,
    });
    say(ch.id, alice, 'alpha only');
    const thirteenth = `${'alpha '.repeat(12)}zebra`;
    expect((await search(alice, thirteenth)).results).toEqual([]);
    const many = Array.from({ length: 13 }, (_, i) => `w${i}`).join(' ');
    say(ch.id, alice, Array.from({ length: 12 }, (_, i) => `w${i}`).join(' '));
    expect((await search(alice, many)).results).toEqual([]);
  });

  it('rejects an empty query and requires a user', async () => {
    await request(as(alice)).get('/api/chat/search').query({ q: '  ' }).expect(400);
    await request(as(null)).get('/api/chat/search').query({ q: 'x' }).expect(401);
  });
});
