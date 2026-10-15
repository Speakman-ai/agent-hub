/**
 * `/api/chat/channels/:id/digests`: members configure a channel's scheduled
 * digests; schedule, timezone and project are validated as the caller.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';
import type { Project, RouteDeps } from '../types.js';

const { initDb } = await import('../db.js');
const { initOrgsDb, setOrgsDbPathForTests, createOrg, setActiveOrgId } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const store = await import('../hub-chat-store.js');
const { default: createHubChatRoutes } = await import('./hub-chat.js');

let alice = '';
let bob = '';
let carol = '';
const projects = [
  { id: 'web', name: 'Web', cwd: '/tmp', agents: [] },
  { id: 'api', name: 'API', cwd: '/tmp', agents: [] },
  {
    id: 'vault',
    name: 'Vault',
    cwd: '/tmp',
    agents: [],
    visibility: 'private',
    ownerUserId: 'nobody',
  },
] as unknown as Project[];

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
      config: {},
      broadcast: () => undefined,
      findProject: (id: string) => projects.find((p) => p.id === id) ?? null,
      getProjects: () => projects,
    } as unknown as RouteDeps),
  );
  return app;
}

let channelId = '';

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hub-chat-digest-route-'));
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
    name: 'ops',
    isPrivate: true,
    createdByUserId: alice,
    memberUserIds: [bob],
  }).id;
});

const url = () => `/api/chat/channels/${channelId}/digests`;
const one = (id: string) => `${url()}/${id}`;

describe('channel digest routes', () => {
  it('lists, creates, updates and removes digests owned by the last editor', async () => {
    expect((await request(as(alice)).get(url()).expect(200)).body).toEqual({ digests: [] });

    const created = await request(as(bob))
      .post(url())
      .send({ cron: '0  9 * * 1-5', timeZone: 'America/New_York', scope: 'channel' })
      .expect(201);
    const id = created.body.digest.id as string;
    expect(created.body.digest).toMatchObject({
      channelId,
      name: 'Channel digest',
      enabled: true,
      cron: '0 9 * * 1-5',
      timeZone: 'America/New_York',
      scope: 'channel',
      projectIds: [],
      prompt: null,
      ownerUserId: bob,
      lastRunAt: null,
    });

    const updated = await request(as(alice))
      .put(one(id))
      .send({ name: 'Evening', cron: '0 17 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(200);
    expect(updated.body.digest).toMatchObject({ id, name: 'Evening', ownerUserId: alice });

    const listed = (await request(as(bob)).get(url()).expect(200)).body.digests;
    expect(listed.map((d: { id: string }) => d.id)).toEqual([id]);

    await request(as(alice)).delete(one(id)).expect(200);
    expect((await request(as(alice)).get(url()).expect(200)).body.digests).toEqual([]);
    await request(as(alice)).delete(one(id)).expect(404);
  });

  it('holds several digests on one channel, up to the cap', async () => {
    for (let i = 0; i < 10; i++) {
      await request(as(alice))
        .post(url())
        .send({ name: `d${i}`, cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
        .expect(201);
    }
    const over = await request(as(alice))
      .post(url())
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(409);
    expect(over.body.code).toBe('digest_limit_reached');
    expect((await request(as(alice)).get(url()).expect(200)).body.digests).toHaveLength(10);
  });

  it('saves a project digest for a project the caller can view', async () => {
    const res = await request(as(alice))
      .post(url())
      .send({ cron: '0 17 * * *', timeZone: 'UTC', scope: 'project', projectIds: ['web'] })
      .expect(201);
    expect(res.body.digest).toMatchObject({
      scope: 'project',
      projectIds: ['web'],
      name: 'Project digest',
    });
  });

  it('saves up to ten projects and a custom prompt', async () => {
    const res = await request(as(alice))
      .post(url())
      .send({
        cron: '0 17 * * *',
        timeZone: 'UTC',
        scope: 'project',
        projectIds: ['web', 'api', 'web'],
        prompt: '  Only blockers.  ',
      })
      .expect(201);
    expect(res.body.digest).toMatchObject({ projectIds: ['web', 'api'], prompt: 'Only blockers.' });
    const id = res.body.digest.id;
    const base = { cron: '0 17 * * *', timeZone: 'UTC', scope: 'project', projectIds: ['api'] };
    // Omitting the prompt on a replace keeps it; null or blank restores the default.
    const kept = await request(as(alice)).put(`${url()}/${id}`).send(base).expect(200);
    expect(kept.body.digest).toMatchObject({ projectIds: ['api'], prompt: 'Only blockers.' });
    const cleared = await request(as(alice))
      .put(`${url()}/${id}`)
      .send({ ...base, prompt: '   ' })
      .expect(200);
    expect(cleared.body.digest.prompt).toBeNull();
    const created = await request(as(alice))
      .post(url())
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel', prompt: 'x'.repeat(4000) })
      .expect(201);
    expect(created.body.digest.prompt).toHaveLength(4000);
  });

  it('rejects bad schedules, zones and projects', async () => {
    const post = (body: Record<string, unknown>) => request(as(alice)).post(url()).send(body);
    expect((await post({ cron: '0 9 * *', timeZone: 'UTC', scope: 'channel' })).body.code).toBe(
      'invalid_cron',
    );
    expect(
      (await post({ cron: '0 9 * * *', timeZone: 'Mars/Base', scope: 'channel' })).body.code,
    ).toBe('invalid_time_zone');
    expect((await post({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'project' })).body.code).toBe(
      'project_required',
    );
    const hidden = await post({
      cron: '0 9 * * *',
      timeZone: 'UTC',
      scope: 'project',
      projectIds: ['vault'],
    });
    expect(hidden.status).toBe(400);
    expect(hidden.body.code).toBe('project_not_found');
    // One hidden project in a list rejects the whole save.
    const mixed = await post({
      cron: '0 9 * * *',
      timeZone: 'UTC',
      scope: 'project',
      projectIds: ['web', 'vault'],
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe('project_not_found');
    const tooMany = await post({
      cron: '0 9 * * *',
      timeZone: 'UTC',
      scope: 'project',
      projectIds: Array.from({ length: 11 }, () => 'web'),
    });
    expect(tooMany.status).toBe(400);
    expect(
      (
        await post({
          cron: '0 9 * * *',
          timeZone: 'UTC',
          scope: 'channel',
          prompt: 'x'.repeat(4001),
        })
      ).status,
    ).toBe(400);
    // The removed singular route is gone.
    await request(as(alice)).get(`/api/chat/channels/${channelId}/digest`).expect(404);
  });

  it('does not reach a digest through another channel', async () => {
    const id = (
      await request(as(alice))
        .post(url())
        .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
        .expect(201)
    ).body.digest.id as string;
    const other = store.createChannel({
      orgId: 'acme',
      kind: 'channel',
      name: 'other',
      isPrivate: true,
      createdByUserId: alice,
      memberUserIds: [],
    }).id;
    const path = `/api/chat/channels/${other}/digests/${id}`;
    await request(as(alice))
      .put(path)
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(404);
    await request(as(alice)).delete(path).expect(404);
    await request(as(alice)).post(`${path}/run`).expect(404);
  });

  it('runs a digest now: a quiet window skips without a model call', async () => {
    const id = (
      await request(as(alice))
        .post(url())
        .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
        .expect(201)
    ).body.digest.id as string;
    const res = await request(as(bob))
      .post(`${one(id)}/run`)
      .expect(200);
    expect(res.body.result).toEqual({ status: 'skipped', reason: 'empty_window' });
    expect(res.body.digest).toMatchObject({ id, lastStatus: 'skipped' });
  });

  it('hides a private channel digest from non-members', async () => {
    await request(as(carol)).get(url()).expect(404);
    await request(as(carol))
      .post(url())
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(404);
  });
});

describe('digest routes under /api/hub-chat', () => {
  const base = () => `/api/hub-chat/channels/${channelId}/digests`;

  it('serves list, create, update, run and delete, sharing rows with /api/chat', async () => {
    const created = await request(as(alice))
      .post(base())
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(201);
    const id = created.body.digest.id as string;

    const viaChat = (await request(as(bob)).get(url()).expect(200)).body.digests;
    expect(viaChat.map((d: { id: string }) => d.id)).toEqual([id]);
    const viaHubChat = (await request(as(bob)).get(base()).expect(200)).body.digests;
    expect(viaHubChat).toEqual(viaChat);

    const updated = await request(as(bob))
      .put(`${base()}/${id}`)
      .send({ name: 'Morning', cron: '0 8 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(200);
    expect(updated.body.digest).toMatchObject({ id, name: 'Morning', ownerUserId: bob });

    const run = await request(as(alice)).post(`${base()}/${id}/run`).expect(200);
    expect(run.body.result.status).toBe('skipped');

    await request(as(alice)).delete(`${base()}/${id}`).expect(200);
    expect((await request(as(alice)).get(url()).expect(200)).body.digests).toEqual([]);
  });

  it('applies the same membership gate', async () => {
    await request(as(carol)).get(base()).expect(404);
  });
});
