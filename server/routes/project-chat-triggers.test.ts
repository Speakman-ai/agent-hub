/**
 * `/api/projects/:projectId/chat-triggers`: create (existing channel or a new
 * trigger channel), list, update and delete, plus destination and manage rules.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';
import { CHAT_MESSAGES_CREATE_SCOPE } from '../google-scopes.js';

/** Scopes each user's Google connection grants; absent = not connected. */
const googleScopes = new Map<string, string[]>();
vi.mock('../google-connections-store.js', async (orig) => ({
  ...(await orig<typeof import('../google-connections-store.js')>()),
  getGoogleConnectionStatus: (userId: string) => ({
    connected: googleScopes.has(userId),
    grantedScopes: googleScopes.get(userId) ?? [],
  }),
}));

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const chat = await import('../hub-chat-store.js');
const { default: createRoutes } = await import('./project-chat-triggers.js');

const PROJECTS: Project[] = [
  { id: 'web', name: 'Web', cwd: '/tmp', agents: [] } as unknown as Project,
  {
    id: 'secret',
    name: 'Secret',
    cwd: '/tmp',
    agents: [],
    visibility: 'private',
  } as unknown as Project,
];

let broadcasts: Record<string, unknown>[] = [];

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
    createRoutes({
      stmts: {},
      config: { googleOAuth: { clientId: 'cid', clientSecret: 'secret' } },
      findProject: (id: string) => PROJECTS.find((p) => p.id === id) ?? null,
      broadcast: (d: Record<string, unknown>) => broadcasts.push(d),
    } as unknown as RouteDeps),
  );
  return app;
}

let alice = '';
let bob = '';
let admin = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'chat-triggers-route-'));
  initDb(dir);
  setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
  initOrgsDb();
  createOrg({ id: 'acme', name: 'Acme', mode: 'remote' });
  setActiveOrgId('acme');
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
  admin = createUser({ username: 'admin', passwordHash: 'x' }).id;
  createMembership(alice, 'acme', 'User');
  createMembership(bob, 'acme', 'User');
  createMembership(admin, 'acme', 'Admin');
  broadcasts = [];
  googleScopes.clear();
});

const base = '/api/projects/web/chat-triggers';

describe('project chat triggers routes', () => {
  it('creates the default activity channel with the first trigger', async () => {
    const list = await request(as(alice)).get(base).expect(200);
    expect(list.body).toEqual({ triggers: [], defaultChannelName: 'web-activity' });

    const res = await request(as(alice))
      .post(base)
      .send({ event: 'pr_merged', newChannel: { name: 'web-activity' } })
      .expect(201);
    const trigger = res.body.trigger;
    expect(trigger).toMatchObject({
      projectId: 'web',
      event: 'pr_merged',
      enabled: true,
      createdByUserId: alice,
      canManage: true,
      channel: { name: 'web-activity', kind: 'trigger', isPrivate: true },
    });
    const channel = chat.getChannel(trigger.channelId)!;
    expect(channel.project_id).toBe('web');
    expect(chat.getMember(channel.id, alice)?.role).toBe('owner');
    expect(broadcasts).toContainEqual(
      expect.objectContaining({ type: 'hub_chat_channel_update', recipientUserIds: [alice] }),
    );
  });

  it('a private project gets a private channel by default', async () => {
    // The visibility gate is not mounted here; this checks channel privacy only.
    const res = await request(as(alice))
      .post('/api/projects/secret/chat-triggers')
      .send({ event: 'card_created', newChannel: { name: 'secret-activity' } })
      .expect(201);
    expect(res.body.trigger.channel.isPrivate).toBe(true);
  });

  it('only routes into a channel the caller belongs to', async () => {
    const mine = chat.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'eng',
      createdByUserId: alice,
    });
    await request(as(bob)).post(base).send({ event: 'pr_opened', channelId: mine.id }).expect(400);
    const dm = chat.getOrCreateDm('acme', alice, bob).channel;
    await request(as(alice)).post(base).send({ event: 'pr_opened', channelId: dm.id }).expect(400);
    await request(as(alice))
      .post(base)
      .send({ event: 'pr_opened', channelId: mine.id })
      .expect(201);
  });

  it('rejects an epic or agent from another project', async () => {
    const { getDb } = await import('../db.js');
    const db = getDb();
    db.prepare(
      "INSERT INTO kanban_boards (id, project_id, name) VALUES ('b-web', 'web', 'Web')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_boards (id, project_id, name) VALUES ('b-secret', 'secret', 'Secret')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_epics (id, board_id, name) VALUES ('epic-web', 'b-web', 'W')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_epics (id, board_id, name) VALUES ('epic-secret', 'b-secret', 'S')",
    ).run();

    const other = await request(as(alice))
      .post(base)
      .send({ event: 'card_moved', filter: { epicId: 'epic-secret' }, newChannel: { name: 'a' } })
      .expect(400);
    expect(other.body).toMatchObject({ code: 'invalid_filter' });
    const agent = await request(as(alice))
      .post(base)
      .send({
        event: 'session_completed',
        filter: { agentIds: ['ghost'] },
        newChannel: { name: 'b' },
      })
      .expect(400);
    expect(agent.body).toMatchObject({ code: 'invalid_filter' });

    const ok = await request(as(alice))
      .post(base)
      .send({ event: 'card_moved', filter: { epicId: 'epic-web' }, newChannel: { name: 'c' } })
      .expect(201);
    // Changing it to another project's epic later is refused too.
    await request(as(alice))
      .patch(`${base}/${ok.body.trigger.id}`)
      .send({ filter: { epicId: 'epic-secret' } })
      .expect(400);
  });

  it('can always disable a trigger whose epic or agent has gone away', async () => {
    const { getDb } = await import('../db.js');
    const db = getDb();
    db.prepare(
      "INSERT INTO kanban_boards (id, project_id, name) VALUES ('b-web2', 'web', 'Web')",
    ).run();
    db.prepare(
      "INSERT INTO kanban_epics (id, board_id, name) VALUES ('epic-gone', 'b-web2', 'G')",
    ).run();
    const web = PROJECTS[0] as unknown as { agents: { id: string }[] };
    web.agents = [{ id: 'dev' }];
    try {
      const card = await request(as(alice))
        .post(base)
        .send({ event: 'card_moved', filter: { epicId: 'epic-gone' }, newChannel: { name: 'e' } })
        .expect(201);
      const session = await request(as(alice))
        .post(base)
        .send({
          event: 'session_completed',
          filter: { agentIds: ['dev'] },
          newChannel: { name: 's' },
        })
        .expect(201);

      // The epic is deleted and the agent leaves the project.
      db.prepare("DELETE FROM kanban_epics WHERE id = 'epic-gone'").run();
      web.agents = [];

      for (const id of [card.body.trigger.id, session.body.trigger.id]) {
        // An admin (who cannot repair the creator's filter) can switch it off.
        const off = await request(as(admin))
          .patch(`${base}/${id}`)
          .send({ enabled: false })
          .expect(200);
        expect(off.body.trigger.enabled).toBe(false);
        // Turning it back on with the stale filter is refused.
        const on = await request(as(alice))
          .patch(`${base}/${id}`)
          .send({ enabled: true })
          .expect(400);
        expect(on.body.code).toBe('invalid_filter');
      }
      // The creator can repair the filter and switch it on in one request.
      await request(as(alice))
        .patch(`${base}/${card.body.trigger.id}`)
        .send({ enabled: true, filter: {} })
        .expect(200);
    } finally {
      web.agents = [];
    }
  });

  it('rejects a filter outcome the event cannot produce', async () => {
    const res = await request(as(alice))
      .post(base)
      .send({ event: 'cron_finished', filter: { outcome: 'pass' }, newChannel: { name: 'x' } })
      .expect(400);
    expect(res.body.code).toBe('invalid_filter');
  });

  it('requires exactly one destination', async () => {
    await request(as(alice)).post(base).send({ event: 'pr_opened' }).expect(400);
  });

  it('only the creator or an admin can update or delete', async () => {
    const created = await request(as(alice))
      .post(base)
      .send({ event: 'card_moved', filter: { columns: ['Done'] }, newChannel: { name: 'w' } })
      .expect(201);
    const id = created.body.trigger.id;

    const asBob = await request(as(bob)).get(base).expect(200);
    expect(asBob.body.triggers[0].canManage).toBe(false);
    await request(as(bob)).patch(`${base}/${id}`).send({ enabled: false }).expect(403);
    await request(as(bob)).delete(`${base}/${id}`).expect(403);

    const patched = await request(as(alice))
      .patch(`${base}/${id}`)
      .send({ enabled: false, filter: { columns: ['Review'], labels: ['chat'] } })
      .expect(200);
    expect(patched.body.trigger).toMatchObject({
      enabled: false,
      filter: { columns: ['Review'], labels: ['chat'] },
    });

    await request(as(admin)).delete(`${base}/${id}`).expect(200);
    const after = await request(as(alice)).get(base).expect(200);
    expect(after.body.triggers).toEqual([]);
  });

  it('an admin cannot retarget another user’s trigger, only switch it off', async () => {
    const created = await request(as(alice))
      .post(base)
      .send({ event: 'pr_opened', newChannel: { name: 'alice-activity', isPrivate: true } })
      .expect(201);
    const id = created.body.trigger.id;
    const adminOnly = chat.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'admin-only',
      isPrivate: true,
      createdByUserId: admin,
    });

    // Pointing Alice's trigger at her sessions in the admin's channel.
    for (const body of [
      { channelId: adminOnly.id },
      { event: 'session_completed' },
      { filter: { agentIds: ['dev'] } },
      { event: 'session_completed', channelId: adminOnly.id, enabled: true },
    ]) {
      const res = await request(as(admin)).patch(`${base}/${id}`).send(body).expect(403);
      expect(res.body.code).toBe('creator_only');
    }
    const unchanged = (await request(as(alice)).get(base).expect(200)).body.triggers[0];
    expect(unchanged).toMatchObject({
      event: 'pr_opened',
      channelId: created.body.trigger.channelId,
    });

    const off = await request(as(admin))
      .patch(`${base}/${id}`)
      .send({ enabled: false })
      .expect(200);
    expect(off.body.trigger.enabled).toBe(false);
  });

  it('hides a private destination channel from non-members', async () => {
    await request(as(alice))
      .post(base)
      .send({ event: 'pr_opened', newChannel: { name: 'quiet', isPrivate: true } })
      .expect(201);
    const res = await request(as(bob)).get(base).expect(200);
    expect(res.body.triggers[0]).toMatchObject({ channel: null, channelId: null });
  });

  it('hides the default activity channel from a project viewer who has not joined', async () => {
    await request(as(alice))
      .post(base)
      .send({ event: 'pr_merged', newChannel: { name: 'web-activity' } })
      .expect(201);
    const res = await request(as(bob)).get(base).expect(200);
    expect(res.body.triggers[0]).toMatchObject({
      event: 'pr_merged',
      channel: null,
      channelId: null,
    });
    // Nor is it listed for Bob to browse and join.
    expect(chat.listJoinableChannels('acme', bob)).toEqual([]);
  });

  it('hides a public destination from non-members too, and shows it once they join', async () => {
    const created = await request(as(alice))
      .post(base)
      .send({ event: 'pr_merged', newChannel: { name: 'open-activity', isPrivate: false } })
      .expect(201);
    const channelId = created.body.trigger.channelId;
    const before = await request(as(bob)).get(base).expect(200);
    expect(before.body.triggers[0]).toMatchObject({ channel: null, channelId: null });

    chat.addMember(channelId, bob);
    const after = await request(as(bob)).get(base).expect(200);
    expect(after.body.triggers[0]).toMatchObject({
      channelId,
      channel: { name: 'open-activity', isPrivate: false },
    });
  });

  it('404s an unknown project or a trigger from another project', async () => {
    await request(as(alice)).get('/api/projects/nope/chat-triggers').expect(404);
    const created = await request(as(alice))
      .post(base)
      .send({ event: 'pr_opened', newChannel: { name: 'w' } })
      .expect(201);
    await request(as(alice))
      .delete(`/api/projects/secret/chat-triggers/${created.body.trigger.id}`)
      .expect(404);
  });

  describe('Google Chat destination', () => {
    async function channelFor(userId: string): Promise<string> {
      const res = await request(as(userId))
        .post(base)
        .send({ event: 'pr_opened', newChannel: { name: `ch-${userId}` } })
        .expect(201);
      return res.body.trigger.channelId as string;
    }

    it('needs the caller to have Google Chat send access', async () => {
      const channelId = await channelFor(alice);
      const res = await request(as(alice))
        .post(base)
        .send({ event: 'pr_merged', channelId, googleChatSpaceId: 'AAAA' })
        .expect(400);
      expect(res.body.code).toBe('google_chat_send_access_required');
    });

    it('stores the space, normalised, and shows it to the creator only', async () => {
      googleScopes.set(alice, [CHAT_MESSAGES_CREATE_SCOPE]);
      const channelId = await channelFor(alice);
      const res = await request(as(alice))
        .post(base)
        .send({ event: 'pr_merged', channelId, googleChatSpaceId: 'spaces/AAAA' })
        .expect(201);
      expect(res.body.trigger).toMatchObject({ googleChat: true, googleChatSpaceId: 'AAAA' });

      const seenByBob = (await request(as(bob)).get(base).expect(200)).body.triggers.find(
        (t: { id: string }) => t.id === res.body.trigger.id,
      );
      expect(seenByBob).toMatchObject({ googleChat: true, googleChatSpaceId: null });
    });

    it('rejects a malformed space id', async () => {
      googleScopes.set(alice, [CHAT_MESSAGES_CREATE_SCOPE]);
      const channelId = await channelFor(alice);
      const res = await request(as(alice))
        .post(base)
        .send({ event: 'pr_merged', channelId, googleChatSpaceId: 'spaces/../x' })
        .expect(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('only the creator may change it, and clearing it never needs Google', async () => {
      googleScopes.set(alice, [CHAT_MESSAGES_CREATE_SCOPE]);
      googleScopes.set(admin, [CHAT_MESSAGES_CREATE_SCOPE]);
      const channelId = await channelFor(alice);
      const created = await request(as(alice))
        .post(base)
        .send({ event: 'pr_merged', channelId, googleChatSpaceId: 'AAAA' })
        .expect(201);
      const url = `${base}/${created.body.trigger.id}`;

      const hijack = await request(as(admin))
        .patch(url)
        .send({ googleChatSpaceId: 'EVIL' })
        .expect(403);
      expect(hijack.body.code).toBe('creator_only');

      // Clearing never needs Google, e.g. after the creator disconnected it.
      googleScopes.delete(alice);
      const cleared = await request(as(alice))
        .patch(url)
        .send({ googleChatSpaceId: null })
        .expect(200);
      expect(cleared.body.trigger).toMatchObject({ googleChat: false, googleChatSpaceId: null });

      const blocked = await request(as(alice))
        .patch(url)
        .send({ googleChatSpaceId: 'BBBB' })
        .expect(400);
      expect(blocked.body.code).toBe('google_chat_send_access_required');
    });
  });
});
