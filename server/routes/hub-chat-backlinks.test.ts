/**
 * Chat backlinks: `GET /api/chat/backlinks` lists messages that reference a
 * card, PR, session or ticket, limited to channels the viewer can read.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';

const { initDb, getDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');

let alice = '';
let bob = '';
let carol = '';
let projects: Project[] = [];

function project(id: string, extra: Partial<Project> = {}): Project {
  return {
    id,
    name: id.toUpperCase(),
    cwd: '/tmp',
    agents: [{ id: `${id}-dev`, name: `${id} Dev`, engine: 'claude-code' }],
    ...extra,
  } as Project;
}

function as(userId: string, orgId = 'acme'): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const areq = req as unknown as Record<string, unknown>;
    areq.authUserId = userId;
    areq.authUser = 'x';
    areq.authRole = 'User';
    areq.authOrgId = orgId;
    next();
  });
  app.use(
    createHubChatRoutes({
      stmts: {},
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      getProjects: () => projects,
    } as unknown as RouteDeps),
  );
  return app;
}

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-backlinks-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  carol = createUser({ username: 'carol', passwordHash: 'x' }).id;
  for (const u of [alice, bob, carol]) createMembership(u, 'acme', 'User');

  // "vault" is private to bob.
  projects = [project('web'), project('vault', { visibility: 'private', ownerUserId: bob })];
  const db = getDb();
  const board = db.prepare(
    'INSERT INTO kanban_boards (id, project_id, name, card_prefix) VALUES (?, ?, ?, ?)',
  );
  board.run('b-web', 'web', 'Board', 'WEB');
  board.run('b-vault', 'vault', 'Board', 'VLT');
  const col = db.prepare(
    'INSERT INTO kanban_columns (id, board_id, name, position) VALUES (?, ?, ?, ?)',
  );
  col.run('col-web', 'b-web', 'To Do', 0);
  col.run('col-vault', 'b-vault', 'To Do', 0);
  const card = db.prepare(
    'INSERT INTO kanban_cards (id, column_id, board_id, title) VALUES (?, ?, ?, ?)',
  );
  card.run('card-web', 'col-web', 'b-web', 'Fix login');
  card.run('card-vault', 'col-vault', 'b-vault', 'Secret');
  const now = Date.now();
  db.prepare(
    `INSERT INTO pull_requests (id, project_id, number, title, head_branch, base_branch, head_sha, status, author, created_at, updated_at)
     VALUES ('pr-web-7', 'web', 7, 'Add retry', 'h', 'main', 'sha', 'open', 'alice', ?, ?)`,
  ).run(now, now);
});

async function channel(owner: string, opts: { isPrivate?: boolean; members?: string[] } = {}) {
  const res = await request(as(owner))
    .post('/api/chat/channels')
    .send({
      name: 'general',
      isPrivate: opts.isPrivate ?? false,
      memberUserIds: opts.members ?? [],
    })
    .expect(201);
  return res.body.channel.id as string;
}

async function post(user: string, channelId: string, body: string): Promise<string> {
  const res = await request(as(user))
    .post(`/api/chat/channels/${channelId}/messages`)
    .send({ body })
    .expect(201);
  return res.body.message.id as string;
}

function backlinks(user: string, kind: string, targetId: string) {
  return request(as(user)).get('/api/chat/backlinks').query({ kind, targetId });
}

describe('GET /api/chat/backlinks', () => {
  it('lists a message once it references the card', async () => {
    const ch = await channel(alice);
    const before = await backlinks(alice, 'card', 'card-web').expect(200);
    expect(before.body.backlinks).toEqual([]);
    expect(before.body.target).toMatchObject({ visible: true, label: 'WEB-1' });

    const id = await post(alice, ch, 'Looking at @[WEB-1](card:card-web) now');
    const res = await backlinks(alice, 'card', 'card-web').expect(200);
    expect(res.body.backlinks).toEqual([
      {
        messageId: id,
        channelId: ch,
        channelKind: 'channel',
        channelLabel: '# general',
        authorKind: 'user',
        authorName: 'alice',
        excerpt: 'Looking at #WEB-1 now',
        createdAt: expect.any(String),
      },
    ]);
  });

  it('shows public channel backlinks to org members who have not joined', async () => {
    const ch = await channel(alice);
    await post(alice, ch, 'see @[web#7](pr:web#7)');
    const res = await backlinks(carol, 'pr', 'web#7').expect(200);
    expect(res.body.backlinks.map((b: { channelId: string }) => b.channelId)).toEqual([ch]);
  });

  it('hides backlinks in private channels and DMs from non-members', async () => {
    const priv = await channel(alice, { isPrivate: true, members: [bob] });
    await post(alice, priv, 'private @[WEB-1](card:card-web)');
    const dm = await request(as(alice)).post('/api/chat/dms').send({ userId: bob }).expect(201);
    await post(alice, dm.body.channel.id, 'dm @[WEB-1](card:card-web)');

    expect((await backlinks(carol, 'card', 'card-web').expect(200)).body.backlinks).toEqual([]);
    const forBob = (await backlinks(bob, 'card', 'card-web').expect(200)).body.backlinks;
    expect(forBob.map((b: { channelLabel: string }) => b.channelLabel).sort()).toEqual([
      '# general',
      'alice',
    ]);
  });

  it('returns nothing when the viewer cannot see the entity itself', async () => {
    const ch = await channel(bob);
    await post(bob, ch, 'roadmap @[VLT-1](card:card-vault)');
    expect((await backlinks(bob, 'card', 'card-vault').expect(200)).body.backlinks).toHaveLength(1);
    const res = await backlinks(alice, 'card', 'card-vault').expect(200);
    expect(res.body.target.visible).toBe(false);
    expect(res.body.backlinks).toEqual([]);
  });

  it('drops deleted messages and archived channels', async () => {
    const ch = await channel(alice);
    const id = await post(alice, ch, 'gone @[WEB-1](card:card-web)');
    await request(as(alice)).delete(`/api/chat/messages/${id}`).expect(200);
    expect((await backlinks(alice, 'card', 'card-web').expect(200)).body.backlinks).toEqual([]);

    const ch2 = await channel(alice);
    await post(alice, ch2, 'still @[WEB-1](card:card-web)');
    getDb()
      .prepare("UPDATE hub_chat_channels SET archived_at = '2026-01-01T00:00:00Z' WHERE id = ?")
      .run(ch2);
    expect((await backlinks(alice, 'card', 'card-web').expect(200)).body.backlinks).toEqual([]);
  });

  it('rejects unsupported kinds', async () => {
    await backlinks(alice, 'user', alice).expect(400);
  });
});
