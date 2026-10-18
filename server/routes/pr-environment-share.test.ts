/**
 * Share-link routes on a bare express app over an in-memory org database.
 * The caller's identity comes from test headers instead of the real auth
 * middleware.
 */
import '../test/setup.js';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../project-visibility-middleware.js', () => ({
  resolveVisibilityCaller: (req: { authUserId?: string; authRole?: string }) => ({
    userId: req.authUserId ?? null,
    role: req.authRole,
  }),
}));

import createPrEnvironmentShareRoutes from './pr-environment-share.js';
import {
  PR_ENVIRONMENT_SHARE_SCHEMA,
  prEnvironmentShareStoreFor,
  verifyShareToken,
  resetMemberTicketsForTest,
  consumeMemberTicket,
} from '../preview/pr-environment-share.js';
import type { RouteDeps } from '../types.js';

const BASE = 'preview.hub.example.com';

function setup(
  opts: { base?: string | null; prStatus?: string; githubEnvStatus?: string | null } = {},
) {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENT_SHARE_SCHEMA);
  const projects: Record<string, unknown> = {
    demo: { id: 'demo', gitHost: 'agenthub' },
    secret: { id: 'secret', gitHost: 'agenthub', visibility: 'private', ownerUserId: 'someone' },
    gh: { id: 'gh' },
    ghp: { id: 'ghp', githubRepo: 'acme/app' },
  };
  const pr = { number: 7, author: 'author-1', status: opts.prStatus ?? 'open' };
  const stmts = {
    getPullRequestByNumber: { get: (_p: string, n: number) => (n === 7 ? pr : undefined) },
  };
  let clock = 1_000_000;
  const deps = {
    findProject: (id: string) => projects[id] ?? null,
    prEnvironments: {
      pin: () => ({
        org: { db, stmts },
        get: (projectId: string, pr: { source: string; prNumber: number }) =>
          projectId === 'ghp' && pr.source === 'github' && pr.prNumber === 7 && opts.githubEnvStatus
            ? { status: opts.githubEnvStatus }
            : null,
      }),
    },
    config: {
      previewSubdomainBase: opts.base === undefined ? BASE : opts.base,
      publicUrl: 'https://hub.example.com',
    },
    now: () => clock,
  } as unknown as Pick<RouteDeps, 'findProject' | 'prEnvironments' | 'config'> & {
    now: () => number;
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const r = req as unknown as Record<string, unknown>;
    if (req.headers['x-user']) r.authUserId = String(req.headers['x-user']);
    r.authRole = String(req.headers['x-role'] ?? 'User');
    next();
  });
  app.use(createPrEnvironmentShareRoutes(deps));
  return {
    app,
    store: prEnvironmentShareStoreFor(db),
    advance: (ms: number) => (clock += ms),
  };
}

const LINKS = '/api/projects/demo/pulls/7/preview/share-links';
const as = (user: string, role = 'User') => ({ 'x-user': user, 'x-role': role });

describe('share link routes', () => {
  beforeEach(() => resetMemberTicketsForTest());

  it('provides a stable generated URL guard password by default, scoped to the org and project', async () => {
    const { app } = setup();
    const first = await request(app).get(LINKS).set(as('viewer'));
    expect(first.status).toBe(200);
    expect(first.body.passwordRequired).toBe(true);
    expect(first.body.generatedPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(first.headers['cache-control']).toBe('no-store');
    const again = await request(app).get(LINKS).set(as('viewer'));
    expect(again.body.generatedPassword).toBe(first.body.generatedPassword);
    const otherOrg = await request(setup().app).get(LINKS).set(as('viewer'));
    expect(otherOrg.body.generatedPassword).not.toBe(first.body.generatedPassword);
    const otherProject = await request(app)
      .get('/api/projects/ghp/pulls/7/preview/share-links')
      .set(as('viewer'));
    expect(otherProject.body.generatedPassword).not.toBe(first.body.generatedPassword);
    const hidden = await request(app)
      .get('/api/projects/secret/pulls/7/preview/share-links')
      .set(as('viewer'));
    expect(hidden.status).toBe(404);
    expect(hidden.body.generatedPassword).toBeUndefined();
  });

  it('preserves custom passwords and explicit removal, and lets admins generate a replacement', async () => {
    const { app, store } = setup();
    const path = '/api/projects/demo/preview-share/password';
    const original = (await request(app).get(LINKS).set(as('viewer'))).body.generatedPassword;
    await request(app).put(path).set(as('a', 'Admin')).send({ password: 'custom-password' });
    expect((await request(app).get(LINKS).set(as('viewer'))).body.generatedPassword).toBeNull();
    await request(app).put(path).set(as('a', 'Admin')).send({ password: null });
    expect((await request(app).get(LINKS).set(as('viewer'))).body).toMatchObject({
      passwordRequired: false,
      generatedPassword: null,
    });
    expect((await request(app).put(path).set(as('viewer')).send({ generate: true })).status).toBe(
      403,
    );
    const generated = await request(app).put(path).set(as('a', 'Admin')).send({ generate: true });
    expect(generated.status).toBe(200);
    expect(generated.body.passwordRequired).toBe(true);
    const replacement = (await request(app).get(LINKS).set(as('viewer'))).body.generatedPassword;
    expect(replacement).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(replacement).not.toBe(original);
    expect(store.getPassword('demo')?.hash).not.toContain(replacement);
  });

  it('the PR author creates a link scoped to the environment host', async () => {
    const { app, store } = setup();
    const res = await request(app)
      .post(LINKS)
      .set(as('author-1'))
      .send({ expiresInHours: 48, label: 'QA vendor' });
    expect(res.status).toBe(201);
    const link = res.body.link;
    expect(link).toMatchObject({
      projectId: 'demo',
      prNumber: 7,
      label: 'QA vendor',
      status: 'active',
    });
    expect(new Date(link.expiresAt).getTime() - new Date(link.createdAt).getTime()).toBe(
      48 * 3600_000,
    );
    const url = new URL(link.url);
    expect(url.host).toBe(`pr-7--demo.${BASE}`);
    const token = url.searchParams.get('share')!;
    expect(verifyShareToken(store, token, { projectId: 'demo', prNumber: 7 }, 1_000_001).ok).toBe(
      true,
    );
  });

  it('Admins and Owners can create; other members cannot', async () => {
    const { app } = setup();
    expect((await request(app).post(LINKS).set(as('a', 'Admin')).send({})).status).toBe(201);
    expect((await request(app).post(LINKS).set(as('o', 'Owner')).send({})).status).toBe(201);
    const denied = await request(app).post(LINKS).set(as('someone-else')).send({});
    expect(denied.status).toBe(403);
  });

  it('validates the body and the PR state', async () => {
    const { app } = setup();
    expect(
      (await request(app).post(LINKS).set(as('author-1')).send({ expiresInHours: 0 })).status,
    ).toBe(400);
    expect(
      (await request(app).post(LINKS).set(as('author-1')).send({ expiresInHours: 721 })).status,
    ).toBe(400);
    const closed = setup({ prStatus: 'merged' });
    expect((await request(closed.app).post(LINKS).set(as('author-1')).send({})).status).toBe(409);
  });

  it('needs wildcard ingress and a hosted project', async () => {
    const noBase = setup({ base: null });
    const res = await request(noBase.app).post(LINKS).set(as('author-1')).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/wildcard preview ingress/);
    expect(res.body.code).toBe('pr_env_ingress_not_configured');
    const { app } = setup();
    const notHosted = await request(app)
      .get('/api/projects/gh/pulls/7/preview/share-links')
      .set(as('a'));
    expect(notHosted.status).toBe(400);
    expect(notHosted.body.code).toBe('pr_env_not_hosted');
    // A plain bad request carries no "unsupported" code, so clients retry it.
    const badNumber = await request(app)
      .get('/api/projects/demo/pulls/x/preview/share-links')
      .set(as('a'));
    expect(badNumber.status).toBe(400);
    expect(badNumber.body.code).toBeUndefined();
    expect(
      (await request(app).get('/api/projects/demo/pulls/9/preview/share-links').set(as('a')))
        .status,
    ).toBe(404);
    expect(
      (await request(app).get('/api/projects/secret/pulls/7/preview/share-links').set(as('a')))
        .status,
    ).toBe(404);
  });

  it('lists links with status and permissions', async () => {
    const { app, advance } = setup();
    await request(app).post(LINKS).set(as('author-1')).send({ expiresInHours: 1 });
    advance(2 * 3600_000);
    await request(app).post(LINKS).set(as('author-1')).send({});
    const asAuthor = await request(app).get(LINKS).set(as('author-1'));
    expect(asAuthor.body.links.map((l: { status: string }) => l.status)).toEqual([
      'active',
      'expired',
    ]);
    expect(asAuthor.body.links[1].url).toBeNull();
    expect(asAuthor.body).toMatchObject({
      passwordRequired: true,
      canManage: true,
      canSetPassword: false,
    });
    const asMember = await request(app).get(LINKS).set(as('viewer'));
    expect(asMember.body).toMatchObject({ canManage: false, canSetPassword: false });
  });

  it('revokes, and only managers or the creator may', async () => {
    const { app, store } = setup();
    const created = await request(app).post(LINKS).set(as('a', 'Admin')).send({});
    const id = created.body.link.id;
    expect((await request(app).delete(`${LINKS}/${id}`).set(as('viewer'))).status).toBe(403);
    const res = await request(app).delete(`${LINKS}/${id}`).set(as('author-1'));
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ status: 'revoked', url: null });
    expect(store.get(id)?.revoked_by).toBe('author-1');
    const token = new URL(created.body.link.url).searchParams.get('share')!;
    expect(verifyShareToken(store, token, { projectId: 'demo', prNumber: 7 }, 1_000_001)).toEqual({
      ok: false,
      reason: 'revoked',
    });
    expect((await request(app).delete(`${LINKS}/missing`).set(as('a', 'Admin'))).status).toBe(404);

    // The creator can revoke their own link even after losing the Admin role.
    const second = await request(app).post(LINKS).set(as('a', 'Admin')).send({});
    expect((await request(app).delete(`${LINKS}/${second.body.link.id}`).set(as('a'))).status).toBe(
      200,
    );
  });

  it('reports canRevoke per link, including for a creator who lost the Admin role', async () => {
    const { app } = setup();
    const created = await request(app).post(LINKS).set(as('a', 'Admin')).send({});
    expect(created.body.link.canRevoke).toBe(true);
    await request(app).post(LINKS).set(as('author-1')).send({});
    const asDemotedCreator = await request(app).get(LINKS).set(as('a'));
    expect(asDemotedCreator.body.canManage).toBe(false);
    const byId = Object.fromEntries(
      asDemotedCreator.body.links.map((l: { id: string; canRevoke: boolean }) => [
        l.id,
        l.canRevoke,
      ]),
    );
    expect(byId[created.body.link.id]).toBe(true);
    expect(Object.values(byId).filter(Boolean)).toHaveLength(1);
    const asViewer = await request(app).get(LINKS).set(as('viewer'));
    expect(asViewer.body.links.every((l: { canRevoke: boolean }) => !l.canRevoke)).toBe(true);
    const revoked = await request(app).delete(`${LINKS}/${created.body.link.id}`).set(as('a'));
    expect(revoked.body.link.canRevoke).toBe(false);
  });

  it('a member gets a single-use ticket URL for the environment', async () => {
    const { app, store } = setup();
    const res = await request(app)
      .post('/api/projects/demo/pulls/7/preview/access')
      .set(as('viewer'));
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.host).toBe(`pr-7--demo.${BASE}`);
    const ticket = url.searchParams.get('share')!;
    expect(ticket).toMatch(/^aht_/);
    expect(
      consumeMemberTicket(store, ticket, { projectId: 'demo', prNumber: 7 }, 1_000_001),
    ).toEqual({
      userId: 'viewer',
    });
  });

  it('a ticket issued in one org is refused by another org with the same project and PR', async () => {
    const orgA = setup();
    const orgB = setup();
    const res = await request(orgA.app)
      .post('/api/projects/demo/pulls/7/preview/access')
      .set(as('viewer'));
    const ticket = new URL(res.body.url).searchParams.get('share')!;
    expect(
      consumeMemberTicket(orgB.store, ticket, { projectId: 'demo', prNumber: 7 }, 1_000_001),
    ).toBeNull();
  });

  it('only Admin/Owner sets the project password', async () => {
    const { app, store } = setup();
    const path = '/api/projects/demo/preview-share/password';
    expect(
      (await request(app).put(path).set(as('author-1')).send({ password: 'hunter22' })).status,
    ).toBe(403);
    expect(
      (await request(app).put(path).set(as('a', 'Admin')).send({ password: 'x' })).status,
    ).toBe(400);
    const set = await request(app).put(path).set(as('a', 'Admin')).send({ password: 'hunter22' });
    expect(set.body).toEqual({ passwordRequired: true });
    expect(store.getPassword('demo')?.hash).toMatch(/^scrypt\$/);
    expect((await request(app).get(LINKS).set(as('a', 'Admin'))).body.passwordRequired).toBe(true);
    const cleared = await request(app).put(path).set(as('o', 'Owner')).send({ password: null });
    expect(cleared.body).toEqual({ passwordRequired: false });
    expect(store.getPassword('demo')).toBeNull();
  });

  it('GitHub-hosted: Admins/Owners manage links while the environment is live', async () => {
    const GH = '/api/projects/ghp/pulls/7/preview/share-links';
    const live = setup({ githubEnvStatus: 'ready' });
    const list = await request(live.app).get(GH).set(as('anyone'));
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ links: [], canManage: false });
    // A GitHub author is not a Hub user, so only managers create.
    expect((await request(live.app).post(GH).set(as('anyone')).send({})).status).toBe(403);
    const created = await request(live.app).post(GH).set(as('a', 'Admin')).send({});
    expect(created.status).toBe(201);
    expect(new URL(created.body.link.url).host).toBe(`pr-7--ghp.${BASE}`);
    const access = await request(live.app)
      .post('/api/projects/ghp/pulls/7/preview/access')
      .set(as('anyone'));
    expect(access.status).toBe(200);

    const stopped = setup({ githubEnvStatus: 'stopped' });
    expect((await request(stopped.app).post(GH).set(as('a', 'Admin')).send({})).status).toBe(409);
    const none = setup({ githubEnvStatus: null });
    expect((await request(none.app).post(GH).set(as('a', 'Admin')).send({})).status).toBe(409);
  });
});
