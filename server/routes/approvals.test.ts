import '../test/setup.js';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
const ap = await import('../approval-requests.js');
const store = await import('../approvals-store.js');
const { default: createApprovalsRoutes } = await import('./approvals.js');

interface Caller {
  userId?: string;
  role?: string;
  viaApiKey?: boolean;
  spawnSessionId?: string;
}

function makeApp(caller: Caller) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const r = req as unknown as Record<string, unknown>;
    if (caller.userId) r.authUserId = caller.userId;
    r.authRole = caller.role ?? 'User';
    if (caller.viaApiKey) r.authViaApiKey = true;
    if (caller.spawnSessionId) r.authSpawnSessionId = caller.spawnSessionId;
    next();
  });
  app.use(createApprovalsRoutes());
  return app;
}

let alice: string;
let bob: string;

function pending(ownerUserId: string | null = alice) {
  const events: Record<string, unknown>[] = [];
  const done = ap.runApprovalReActStep(
    { op: 'request', action: 'publish', target: 'https://blog.example.com/post/1' },
    { sessionId: 'sess-1', ownerUserId, agentId: 'agent-a', projectId: 'proj-1' },
    { broadcast: (d) => events.push(d) },
  );
  const id = (events[0]!.approval as { id: string }).id;
  return { id, done };
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'approvals-routes-'));
  __resetSecretCryptoForTests();
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  alice = createUser({ username: 'alice', passwordHash: 'x' }).id;
  bob = createUser({ username: 'bob', passwordHash: 'x' }).id;
});

afterEach(() => {
  ap.__resetApprovalWaitersForTests();
});

describe('/api/me/approvals', () => {
  it('requires a human caller', async () => {
    await request(makeApp({})).get('/api/me/approvals').expect(401);
    await request(makeApp({ viaApiKey: true, role: 'Owner' }))
      .get('/api/me/approvals')
      .expect(403);
    await request(makeApp({ userId: alice, spawnSessionId: 'sess-1' }))
      .get('/api/me/approvals')
      .expect(403);
    await request(makeApp({ userId: alice }))
      .get('/api/me/approvals')
      .set('X-Agent-Hub-Session-Id', 'sess-1')
      .expect(403);
  });

  it('an agent cannot answer its own approval', async () => {
    const { id, done } = pending();
    await request(makeApp({ userId: alice, spawnSessionId: 'sess-1' }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'allow_once' })
      .expect(403);
    expect(store.getApprovalRequest(id)!.status).toBe('pending');
    ap.abortApprovalsForSession('sess-1', 'test');
    await done;
  });

  it('lists the caller pending approvals only', async () => {
    const { id, done } = pending();
    const mine = await request(makeApp({ userId: alice }))
      .get('/api/me/approvals?status=pending')
      .expect(200);
    expect(mine.body.approvals).toHaveLength(1);
    expect(mine.body.approvals[0]).toMatchObject({
      id,
      action: 'publish',
      domain: 'blog.example.com',
      canRemember: true,
      status: 'pending',
    });
    const theirs = await request(makeApp({ userId: bob }))
      .get('/api/me/approvals')
      .expect(200);
    expect(theirs.body.approvals).toHaveLength(0);
    await request(makeApp({ userId: bob }))
      .get(`/api/me/approvals/${id}`)
      .expect(404);
    await request(makeApp({ userId: alice }))
      .get('/api/me/approvals?status=nope')
      .expect(400);
    ap.abortApprovalsForSession('sess-1', 'test');
    await done;
  });

  it('answers resume the turn; a second answer is 409', async () => {
    const { id, done } = pending();
    await request(makeApp({ userId: alice }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'maybe' })
      .expect(400);
    await request(makeApp({ userId: bob }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'allow_once' })
      .expect(404);

    const res = await request(makeApp({ userId: alice }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'deny' })
      .expect(200);
    expect(res.body).toMatchObject({
      approval: { id, status: 'denied', resolution: 'deny' },
      ruleId: null,
    });
    expect((await done).hostDetail).toBe('deny');

    await request(makeApp({ userId: alice }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'allow_once' })
      .expect(409);
  });

  it('always_allow returns the rule, which is listed and deletable', async () => {
    const { id, done } = pending();
    const res = await request(makeApp({ userId: alice }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'always_allow' })
      .expect(200);
    expect(res.body.ruleId).toEqual(expect.any(String));
    expect((await done).hostDetail).toBe('always_allow');

    const rules = await request(makeApp({ userId: alice })).get('/api/me/approval-rules');
    expect(rules.body.rules).toEqual([
      expect.objectContaining({
        id: res.body.ruleId,
        domain: 'blog.example.com',
        action: 'publish',
        effect: 'allow',
      }),
    ]);
    await request(makeApp({ userId: bob }))
      .delete(`/api/me/approval-rules/${res.body.ruleId}`)
      .expect(404);
    await request(makeApp({ userId: alice }))
      .delete(`/api/me/approval-rules/${res.body.ruleId}`)
      .expect(200);
    const after = await request(makeApp({ userId: alice })).get('/api/me/approval-rules');
    expect(after.body.rules).toHaveLength(0);
  });

  it('an ownerless approval is answerable by an Admin, not a User', async () => {
    const { id, done } = pending(null);
    await request(makeApp({ userId: bob }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'allow_once' })
      .expect(404);
    await request(makeApp({ userId: bob, role: 'Admin' }))
      .post(`/api/me/approvals/${id}/answer`)
      .send({ decision: 'allow_once' })
      .expect(200);
    expect((await done).hostDetail).toBe('allow_once');
  });
});

describe('POST /api/me/approval-rules', () => {
  async function profileFor(userId: string) {
    const profiles = await import('../browser-profiles-store.js');
    return profiles.getOrCreateBrowserProfile({ userId, agentId: 'agent-a', projectId: 'proj-1' });
  }

  it('saves a require rule (the default effect) that beats always-allow', async () => {
    const p = await profileFor(alice);
    store.saveApprovalRule({
      profileId: p.id,
      userId: alice,
      domain: 'shop.com',
      action: 'click',
      effect: 'allow',
    });
    const res = await request(makeApp({ userId: alice }))
      .post('/api/me/approval-rules')
      .send({ profileId: p.id, domain: 'https://Shop.com/cart', action: 'click' })
      .expect(201);
    expect(res.body.rule).toMatchObject({ domain: 'shop.com', action: 'click', effect: 'require' });
    expect(
      store.findApprovalRule({ profileId: p.id, domain: 'shop.com', action: 'click' }),
    ).toMatchObject({ effect: 'require' });
  });

  it('accepts "*" only for require rules', async () => {
    const p = await profileFor(alice);
    const app = makeApp({ userId: alice });
    await request(app)
      .post('/api/me/approval-rules')
      .send({ profileId: p.id, domain: 'bank.com', action: '*', effect: 'allow' })
      .expect(400);
    await request(app)
      .post('/api/me/approval-rules')
      .send({ profileId: p.id, domain: 'bank.com', action: '*' })
      .expect(201);
  });

  it("rejects bad input, other users' profiles and agent callers", async () => {
    const p = await profileFor(alice);
    const body = { profileId: p.id, domain: 'bank.com', action: 'click' };
    await request(makeApp({ userId: alice }))
      .post('/api/me/approval-rules')
      .send({ ...body, effect: 'nope' })
      .expect(400);
    await request(makeApp({ userId: alice }))
      .post('/api/me/approval-rules')
      .send({ ...body, domain: '' })
      .expect(400);
    await request(makeApp({ userId: bob }))
      .post('/api/me/approval-rules')
      .send(body)
      .expect(404);
    await request(makeApp({ userId: alice, viaApiKey: true }))
      .post('/api/me/approval-rules')
      .send(body)
      .expect(403);
  });
});
