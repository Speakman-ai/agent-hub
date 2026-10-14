/**
 * `/api/chat/channels/:id/digest`: members configure a channel's scheduled
 * digest; schedule, timezone and project are validated as the caller.
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

const url = () => `/api/chat/channels/${channelId}/digest`;

describe('channel digest routes', () => {
  it('starts empty, saves a channel digest owned by the caller, and removes it', async () => {
    expect((await request(as(alice)).get(url()).expect(200)).body).toEqual({ digest: null });

    const saved = await request(as(bob))
      .put(url())
      .send({ cron: '0  9 * * 1-5', timeZone: 'America/New_York', scope: 'channel' })
      .expect(200);
    expect(saved.body.digest).toMatchObject({
      channelId,
      enabled: true,
      cron: '0 9 * * 1-5',
      timeZone: 'America/New_York',
      scope: 'channel',
      projectId: null,
      ownerUserId: bob,
      lastRunAt: null,
    });
    expect((await request(as(alice)).get(url()).expect(200)).body.digest.ownerUserId).toBe(bob);

    await request(as(alice)).delete(url()).expect(200);
    expect((await request(as(alice)).get(url()).expect(200)).body.digest).toBeNull();
  });

  it('saves a project digest for a project the caller can view', async () => {
    const res = await request(as(alice))
      .put(url())
      .send({ cron: '0 17 * * *', timeZone: 'UTC', scope: 'project', projectId: 'web' })
      .expect(200);
    expect(res.body.digest).toMatchObject({ scope: 'project', projectId: 'web' });
  });

  it('rejects bad schedules, zones and projects', async () => {
    const put = (body: Record<string, unknown>) => request(as(alice)).put(url()).send(body);
    expect((await put({ cron: '0 9 * *', timeZone: 'UTC', scope: 'channel' })).body.code).toBe(
      'invalid_cron',
    );
    expect(
      (await put({ cron: '0 9 * * *', timeZone: 'Mars/Base', scope: 'channel' })).body.code,
    ).toBe('invalid_time_zone');
    expect((await put({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'project' })).body.code).toBe(
      'project_required',
    );
    const hidden = await put({
      cron: '0 9 * * *',
      timeZone: 'UTC',
      scope: 'project',
      projectId: 'vault',
    });
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe('project_not_found');
  });

  it('hides a private channel digest from non-members', async () => {
    await request(as(carol)).get(url()).expect(404);
    await request(as(carol))
      .put(url())
      .send({ cron: '0 9 * * *', timeZone: 'UTC', scope: 'channel' })
      .expect(404);
  });
});
