/**
 * Tests for per-project RUM ingest clients:
 *
 *   POST   /api/projects/:projectId/rum/clients          (Admin+)
 *   GET    /api/projects/:projectId/rum/clients          (Admin+)
 *   DELETE /api/projects/:projectId/rum/clients/:clientId (Admin+)
 *
 * plus the `X-RUM-Token` authentication + per-project attribution gate on the
 * public `POST /api/replays` ingest, and direct unit coverage of the store
 * (mint / verify / list / revoke).
 *
 * No real CLI binaries are spawned — these are pure HTTP + SQLite paths.
 * getRequest() boots the test server (which initialises the per-file DB) before
 * any store call.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import type supertest from 'supertest';

import './setup.js';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import {
  mintRumClient,
  verifyRumToken,
  listRumClients,
  revokeRumClient,
} from '../rum-clients-store.js';
import {
  _resetRateLimit,
  _projectRateBuckets,
  _rateBuckets,
  RUM_PROJECT_RATE_LIMIT_MAX,
} from '../routes/replays.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'rum-clients-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `rum-clients-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `rum-clients-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

let _counter = 0;
function uid(prefix = 'rum'): string {
  return `${prefix}-${Date.now()}-${++_counter}`;
}

async function makeProject(): Promise<string> {
  const id = uid('proj');
  const res = await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ id, name: `Test ${id}`, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return (res.body as { id: string }).id;
}

async function mintToken(projectId: string, name = 'vendor'): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/rum/clients`)
    .set('Authorization', `Bearer ${adminJwt}`)
    .send({ name })
    .expect(201);
  return (res.body as { token: string }).token;
}

const SNAPSHOT = { type: 2, timestamp: 1000, data: { node: {} } };

/** A window-active bucket entry preloaded to `count` (test helper). */
function preloadProjectBucket(projectId: string, count: number): void {
  _projectRateBuckets.set(projectId, { count, resetAt: Date.now() + 60 * 60 * 1000 });
}

// ─── Store unit tests ────────────────────────────────────────────────

describe('rum-clients-store', () => {
  it('mints a rum_-prefixed token returned once and verifiable', () => {
    const projectId = `store-proj-${++_counter}`;
    const minted = mintRumClient(projectId, 'vendor site', 'admin-1');
    expect(minted.token).toMatch(/^rum_[A-Za-z0-9_-]{40,}$/);
    expect(minted.projectId).toBe(projectId);
    expect(minted.name).toBe('vendor site');
    expect(minted.createdBy).toBe('admin-1');
    expect(minted.prefix).toBe(minted.token.slice(0, 12));

    const verified = verifyRumToken(minted.token);
    expect(verified).toEqual({
      clientId: minted.id,
      projectId,
      name: 'vendor site',
    });
  });

  it('rejects malformed / unknown tokens', () => {
    expect(verifyRumToken('')).toBeNull();
    expect(verifyRumToken('not-a-token')).toBeNull();
    expect(verifyRumToken('ahub_abc')).toBeNull();
    expect(verifyRumToken(null)).toBeNull();
    expect(verifyRumToken('rum_neverminted0000000000000000000000000000')).toBeNull();
  });

  it('lists only active clients for the project', () => {
    const projectId = `store-proj-${++_counter}`;
    const a = mintRumClient(projectId, 'a');
    const b = mintRumClient(projectId, 'b');
    const list = listRumClients(projectId);
    // Both present (created_at is second-granular, so insertion order isn't a
    // reliable tiebreak — assert membership, not a fixed sequence).
    expect(list.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    // No token or hash leaks into the listing.
    for (const c of list) {
      expect(Object.keys(c)).not.toContain('token');
      expect(Object.keys(c)).not.toContain('token_hash');
    }
  });

  it('revoke is scoped to the project and disables verification', () => {
    const projectId = `store-proj-${++_counter}`;
    const minted = mintRumClient(projectId, 'to revoke');
    expect(verifyRumToken(minted.token)).not.toBeNull();

    // A different project cannot revoke it.
    expect(revokeRumClient('some-other-project', minted.id)).toBe(false);
    expect(verifyRumToken(minted.token)).not.toBeNull();

    // The owning project can.
    expect(revokeRumClient(projectId, minted.id)).toBe(true);
    expect(verifyRumToken(minted.token)).toBeNull();
    expect(listRumClients(projectId)).toHaveLength(0);
    // Second revoke is a no-op.
    expect(revokeRumClient(projectId, minted.id)).toBe(false);
  });

  it('rejects an empty name', () => {
    expect(() => mintRumClient('p', '   ')).toThrow(/name must be/);
  });
});

// ─── Admin route tests ───────────────────────────────────────────────

describe('POST /api/projects/:projectId/rum/clients', () => {
  it('403 when the caller is below Admin', async () => {
    const res = await request
      .post('/api/projects/any/rum/clients')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ name: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
  });

  it('404 when the project does not exist', async () => {
    const res = await request
      .post('/api/projects/no-such-project/rum/clients')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('400 on an empty name', async () => {
    const projectId = await makeProject();
    const res = await request
      .post(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: '' });
    expect(res.status).toBe(400);
  });

  it('mints a token returned once, then lists it without the token', async () => {
    const projectId = await makeProject();
    const mint = await request
      .post(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'acme.com' })
      .expect(201);
    expect(mint.body.token).toMatch(/^rum_[A-Za-z0-9_-]{40,}$/);
    expect(mint.body.projectId).toBe(projectId);

    const list = await request
      .get(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(list.body.projectId).toBe(projectId);
    expect(list.body.clients).toHaveLength(1);
    expect(list.body.clients[0].id).toBe(mint.body.id);
    expect(list.body.clients[0].token).toBeUndefined();
    expect(list.body.clients[0].prefix).toBe(mint.body.prefix);
  });

  it('revokes a client (and 404s an unknown clientId)', async () => {
    const projectId = await makeProject();
    const mint = await request
      .post(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'temp' })
      .expect(201);

    await request
      .delete(`/api/projects/${projectId}/rum/clients/${mint.body.id}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    // Gone from the list.
    const list = await request
      .get(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(list.body.clients).toHaveLength(0);

    // Re-delete → 404.
    await request
      .delete(`/api/projects/${projectId}/rum/clients/${mint.body.id}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(404);
  });
});

// ─── Ingest gate (X-RUM-Token) ───────────────────────────────────────

describe('POST /api/replays — X-RUM-Token gate', () => {
  beforeEach(() => {
    _resetRateLimit();
  });

  it('attributes the replay to the token’s project when a valid token is sent', async () => {
    const projectId = await makeProject();
    const mint = await request
      .post(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'vendor' })
      .expect(201);

    const res = await request
      .post('/api/replays')
      .set('X-RUM-Token', mint.body.token)
      .send({ events: [SNAPSHOT], meta: { trigger: 'rum' } })
      .expect(201);
    expect(res.body.projectId).toBe(projectId);
    expect(typeof res.body.replayId).toBe('string');
  });

  it('rejects an invalid token with 401 and stores nothing', async () => {
    const res = await request
      .post('/api/replays')
      .set('X-RUM-Token', 'rum_thisisnotarealtoken000000000000000000000000')
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it('rejects a revoked token with 401', async () => {
    const projectId = await makeProject();
    const mint = await request
      .post(`/api/projects/${projectId}/rum/clients`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ name: 'soon-revoked' })
      .expect(201);
    await request
      .delete(`/api/projects/${projectId}/rum/clients/${mint.body.id}`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    await request
      .post('/api/replays')
      .set('X-RUM-Token', mint.body.token)
      .send({ events: [SNAPSHOT] })
      .expect(401);
  });

  it('rate-limits invalid-token attempts via the per-IP bucket (no abuse bypass)', async () => {
    const badToken = 'rum_thisisnotarealtoken000000000000000000000000';
    // The anonymous per-IP budget is 30/hr. Invalid-token attempts must consume
    // the SAME bucket, so a bogus header can't dodge abuse control: the first 30
    // attempts are rejected 401, and once the IP budget is spent further attempts
    // get 429 rather than an unlimited stream of cheap-to-spam 401s.
    for (let i = 0; i < 30; i++) {
      await request
        .post('/api/replays')
        .set('X-RUM-Token', badToken)
        .send({ events: [SNAPSHOT] })
        .expect(401);
    }
    const res = await request
      .post('/api/replays')
      .set('X-RUM-Token', badToken)
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('invalid-token attempts share the anonymous IP budget', async () => {
    const badToken = 'rum_thisisnotarealtoken000000000000000000000000';
    // Spend most of the per-IP budget on invalid-token attempts...
    for (let i = 0; i < 30; i++) {
      await request
        .post('/api/replays')
        .set('X-RUM-Token', badToken)
        .send({ events: [SNAPSHOT] })
        .expect(401);
    }
    // ...then a plain anonymous ingest from the same IP is already over budget.
    await request
      .post('/api/replays')
      .send({ events: [SNAPSHOT] })
      .expect(429);
  });

  it('keeps the anonymous path working (no token → unattributed replay)', async () => {
    const res = await request
      .post('/api/replays')
      .send({ events: [SNAPSHOT] })
      .expect(201);
    expect(res.body.projectId).toBeNull();
  });
});

describe('POST /api/replays — valid-token per-project rate limit', () => {
  beforeEach(() => {
    _resetRateLimit();
  });

  it('caps successful token ingest at the per-project budget (429) without touching the per-IP budget', async () => {
    const projectId = await makeProject();
    const token = await mintToken(projectId);

    // Simulate the project having already reached its hourly ingest budget.
    preloadProjectBucket(projectId, RUM_PROJECT_RATE_LIMIT_MAX);

    const res = await request
      .post('/api/replays')
      .set('X-RUM-Token', token)
      .send({ events: [SNAPSHOT] });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();

    // Valid-token traffic must never draw down the anonymous per-IP bucket — the
    // precheck only peeks it and the success path charges the project bucket.
    expect(_rateBuckets.size).toBe(0);
  });

  it('increments the project bucket and caps exactly at the configured budget', async () => {
    const projectId = await makeProject();
    const token = await mintToken(projectId);

    // One slot left in the window → the next ingest succeeds and fills it.
    preloadProjectBucket(projectId, RUM_PROJECT_RATE_LIMIT_MAX - 1);
    await request
      .post('/api/replays')
      .set('X-RUM-Token', token)
      .send({ events: [SNAPSHOT] })
      .expect(201);
    expect(_projectRateBuckets.get(projectId)?.count).toBe(RUM_PROJECT_RATE_LIMIT_MAX);

    // Budget now spent → the following ingest is throttled.
    await request
      .post('/api/replays')
      .set('X-RUM-Token', token)
      .send({ events: [SNAPSHOT] })
      .expect(429);
  });

  it('keys the budget by project, not by token or client IP', async () => {
    const projectA = await makeProject();
    const projectB = await makeProject();
    const tokenA1 = await mintToken(projectA, 'a1');
    const tokenA2 = await mintToken(projectA, 'a2');
    const tokenB = await mintToken(projectB, 'b');

    // Exhaust project A's budget.
    preloadProjectBucket(projectA, RUM_PROJECT_RATE_LIMIT_MAX);

    // BOTH of project A's tokens are throttled → the bucket is keyed by project,
    // not by individual token.
    await request
      .post('/api/replays')
      .set('X-RUM-Token', tokenA1)
      .send({ events: [SNAPSHOT] })
      .expect(429);
    await request
      .post('/api/replays')
      .set('X-RUM-Token', tokenA2)
      .send({ events: [SNAPSHOT] })
      .expect(429);

    // Project B (same client IP, different project) is unaffected → not keyed by
    // IP either.
    const resB = await request
      .post('/api/replays')
      .set('X-RUM-Token', tokenB)
      .send({ events: [SNAPSHOT] })
      .expect(201);
    expect(resB.body.projectId).toBe(projectB);
  });
});
