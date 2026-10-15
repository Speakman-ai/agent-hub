import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteDeps } from '../types.js';

let TMP_DIR = '';
vi.mock('../config.js', async (orig) => {
  const actual = (await orig()) as { default: Record<string, unknown> };
  return {
    ...actual,
    default: new Proxy(actual.default, {
      get(target, prop) {
        if (prop === 'dataDir') return TMP_DIR;
        if (prop === 'apiKey') return null;
        return Reflect.get(target, prop);
      },
    }),
  };
});

const { initOrgsDb, setOrgsDbPathForTests } = await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { __resetSecretCryptoForTests } = await import('../secret-crypto.js');
const store = await import('../browser-profiles-store.js');
const { default: createMeBrowserProfilesRoutes } = await import('./me-browser-profiles.js');

const SECRET = 'cookie-value-must-not-leak';

function makeApp(userId: string | null) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (userId) (req as unknown as { authUserId?: string }).authUserId = userId;
    next();
  });
  const deps = {
    findAgent: (id: string) =>
      id === 'agent-a' ? { agent: { id, name: 'Agent A' }, project: { id: 'proj-1' } } : null,
    findProject: (id: string) => (id === 'proj-1' ? { id, name: 'Project One' } : null),
  } as unknown as RouteDeps;
  app.use(createMeBrowserProfilesRoutes(deps));
  return app;
}

let alice: string;
let bob: string;

function seed(userId: string, agentId = 'agent-a') {
  const key = { userId, agentId, projectId: 'proj-1' };
  store.acquireBrowserProfileLease(key, 'sess-1');
  const p = store.saveBrowserProfileState(key, 'sess-1', {
    cookies: [
      { name: 'sid', value: SECRET, domain: '.github.com', path: '/' },
      { name: 'x', value: SECRET, domain: 'github.com', path: '/' },
      { name: 'g', value: SECRET, domain: '.google.com', path: '/' },
    ],
    origins: [{ origin: 'https://github.com', localStorage: [{ name: 't', value: SECRET }] }],
  });
  store.releaseBrowserProfileLease(key, 'sess-1');
  return p;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'me-browser-profiles-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
});

describe('/api/me/browser-profiles', () => {
  it('requires authentication', async () => {
    await request(makeApp(null)).get('/api/me/browser-profiles').expect(401);
  });

  it("lists only the caller's profiles with names and no cookie contents", async () => {
    const mine = seed(alice);
    seed(bob);
    const res = await request(makeApp(alice)).get('/api/me/browser-profiles').expect(200);
    expect(res.body.profiles).toHaveLength(1);
    expect(res.body.profiles[0]).toMatchObject({
      id: mine.id,
      agentName: 'Agent A',
      projectName: 'Project One',
      domains: ['github.com', 'google.com'],
      hasState: true,
      inUse: false,
    });
    expect(res.body.profiles[0].lastUsedAt).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('lists per-domain counts without values', async () => {
    const p = seed(alice);
    const res = await request(makeApp(alice))
      .get(`/api/me/browser-profiles/${p.id}/domains`)
      .expect(200);
    expect(res.body.domains).toEqual([
      { domain: 'github.com', cookieCount: 2, hasSiteStorage: true },
      { domain: 'google.com', cookieCount: 1, hasSiteStorage: false },
    ]);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it("returns 404 for another user's profile on every route", async () => {
    const bobs = seed(bob);
    const app = makeApp(alice);
    await request(app).get(`/api/me/browser-profiles/${bobs.id}/domains`).expect(404);
    await request(app).delete(`/api/me/browser-profiles/${bobs.id}/domains/github.com`).expect(404);
    await request(app).delete(`/api/me/browser-profiles/${bobs.id}`).expect(404);
    expect(store.getBrowserProfileForUser(bob, bobs.id)?.domains).toEqual([
      'github.com',
      'google.com',
    ]);
  });

  it("clears one domain's cookies and storage and keeps the rest", async () => {
    const p = seed(alice);
    const app = makeApp(alice);
    const res = await request(app)
      .delete(`/api/me/browser-profiles/${p.id}/domains/github.com`)
      .expect(200);
    expect(res.body.domains).toEqual(['google.com']);
    const state = store.loadBrowserProfileState(p)!;
    expect(state.cookies.map((c) => c.domain)).toEqual(['.google.com']);
    expect(state.origins).toEqual([]);
    await request(app).delete(`/api/me/browser-profiles/${p.id}/domains/github.com`).expect(404);
  });

  it('refuses to clear a domain while a session holds the lease', async () => {
    const p = seed(alice);
    store.acquireBrowserProfileLease(p, 'sess-2');
    await request(makeApp(alice))
      .delete(`/api/me/browser-profiles/${p.id}/domains/github.com`)
      .expect(409);
    expect(store.getBrowserProfileForUser(alice, p.id)?.domains).toContain('github.com');
  });

  it('deletes a profile', async () => {
    const p = seed(alice);
    await request(makeApp(alice)).delete(`/api/me/browser-profiles/${p.id}`).expect(200);
    expect(store.listBrowserProfilesForUser(alice)).toEqual([]);
  });
});
