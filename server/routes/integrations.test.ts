/**
 * Integration tests for `/api/users/:userId/integrations/*` and the
 * Nango webhook endpoint.
 *
 * Coverage matrix:
 *   - happy path: connect → list → get → delete
 *   - cross-user reads/writes return 404 (not 403)
 *   - Owner role bypasses the user-id gate
 *   - double-connect upserts and stays at status PENDING
 *   - webhook signature verification (valid + invalid + missing)
 *   - webhook flips PENDING → CONNECTED on auth.creation
 *   - webhook ignores non-auth-creation events
 *   - webhook rejects cross-tenant endUserId silently
 *   - delete tolerates upstream 404 but propagates 5xx
 *
 * The IntegrationProvider is a hand-rolled fake so CI never needs a
 * real Nango key.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import supertest from 'supertest';
import crypto from 'crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import * as userIntegrationsStore from '../user-integrations-store.js';
import createIntegrationsRoutes from './integrations.js';
import {
  IntegrationProviderError,
  type IntegrationProvider,
  type UserConnection,
} from '../integrations/provider.js';
import type { Role } from '../roles.js';
import type { RouteDeps } from '../types.js';
import type { AuthenticatedRequest } from '../auth.js';

// ── Test fixtures ─────────────────────────────────────────────────

const HUB_INSTANCE_ID = 'hub-instance-aaaaaaaa';
const WEBHOOK_SECRET = 'whsec_test_secret';
const ALICE = 'user-alice';
const BOB = 'user-bob';

interface FakeProviderState {
  createCalls: Array<{ hubInstanceId: string; userId: string; app: string }>;
  deleteCalls: string[];
  /** When set, createConnection throws this error. */
  createError?: IntegrationProviderError | Error;
  /** When set, deleteConnection throws this error. */
  deleteError?: IntegrationProviderError | Error;
  /** Sequence of connectionIds to return — defaults to deterministic strings. */
  nextTokens: string[];
}

function makeFakeProvider(state: FakeProviderState): IntegrationProvider {
  return {
    async createConnection({ hubInstanceId, userId, app }) {
      state.createCalls.push({ hubInstanceId, userId, app });
      if (state.createError) throw state.createError;
      const token = state.nextTokens.shift() ?? `tok-${state.createCalls.length}`;
      return {
        authUrl: `https://nango.test/connect/${token}`,
        connectionId: token,
        endUserId: `${hubInstanceId}:${userId}`,
      };
    },
    async listConnections(): Promise<UserConnection[]> {
      return [];
    },
    async proxyCall() {
      return null;
    },
    async deleteConnection(connectionId: string) {
      state.deleteCalls.push(connectionId);
      if (state.deleteError) throw state.deleteError;
    },
  };
}

// ── App harness ───────────────────────────────────────────────────

let app: Express;
let role: Role;
let userId: string;
let providerState: FakeProviderState;

function fakeAuth(req: Request, _res: Response, next: NextFunction): void {
  (req as AuthenticatedRequest).authRole = role;
  (req as AuthenticatedRequest).authUserId = userId;
  next();
}

function buildApp(opts: { webhookSecret?: string } = {}): Express {
  const a = express();
  a.use(
    express.json({
      verify: (req: Request, _res, buf: Buffer) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  a.use(fakeAuth);
  a.use(
    createIntegrationsRoutes({} as unknown as RouteDeps, {
      getProvider: () => makeFakeProvider(providerState),
      getWebhookSecret: () =>
        opts.webhookSecret === undefined ? WEBHOOK_SECRET : opts.webhookSecret,
      getHubInstanceId: () => HUB_INSTANCE_ID,
    }),
  );
  return a;
}

let TMP_DIR = '';

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'integrations-route-test-'));
  mkdirSync(TMP_DIR, { recursive: true });
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  role = 'User';
  userId = ALICE;
  providerState = { createCalls: [], deleteCalls: [], nextTokens: [] };
  app = buildApp();
});

afterEach(() => {
  setOrgsDbPathForTests(null);
  if (TMP_DIR) {
    rmSync(TMP_DIR, { recursive: true, force: true });
  }
});

// ── Tests ─────────────────────────────────────────────────────────

describe('POST /api/users/:userId/integrations/:app/connect', () => {
  it('happy path — creates session, persists PENDING row, returns authUrl', async () => {
    providerState.nextTokens = ['session-token-1'];
    const res = await supertest(app)
      .post(`/api/users/${ALICE}/integrations/slack/connect`)
      .send({})
      .expect(201);

    expect(res.body.connectionId).toBe('session-token-1');
    expect(res.body.authUrl).toContain('https://nango.test/connect/');
    expect(providerState.createCalls).toEqual([
      { hubInstanceId: HUB_INSTANCE_ID, userId: ALICE, app: 'slack' },
    ]);

    const row = userIntegrationsStore.getForUser(ALICE, 'slack');
    expect(row?.status).toBe('PENDING');
    expect(row?.connectionId).toBe('session-token-1');
    expect(row?.metadata).toEqual({ endUserId: `${HUB_INSTANCE_ID}:${ALICE}` });
  });

  it('cross-user POST returns 404 (not 403) and does NOT call provider', async () => {
    role = 'User';
    userId = ALICE;
    await supertest(app).post(`/api/users/${BOB}/integrations/slack/connect`).send({}).expect(404);
    expect(providerState.createCalls).toHaveLength(0);
    expect(userIntegrationsStore.getForUser(BOB, 'slack')).toBeNull();
  });

  it('Owner can connect on behalf of another user', async () => {
    role = 'Owner';
    userId = 'owner-1';
    providerState.nextTokens = ['owner-tok'];
    const res = await supertest(app)
      .post(`/api/users/${BOB}/integrations/slack/connect`)
      .send({})
      .expect(201);
    expect(res.body.connectionId).toBe('owner-tok');
    const row = userIntegrationsStore.getForUser(BOB, 'slack');
    expect(row?.status).toBe('PENDING');
  });

  it('double-connect is idempotent — second call upserts the same (user,app) row', async () => {
    providerState.nextTokens = ['tok-1', 'tok-2'];
    await supertest(app)
      .post(`/api/users/${ALICE}/integrations/slack/connect`)
      .send({})
      .expect(201);
    await supertest(app)
      .post(`/api/users/${ALICE}/integrations/slack/connect`)
      .send({})
      .expect(201);

    const list = userIntegrationsStore.listForUser(ALICE);
    expect(list).toHaveLength(1);
    expect(list[0].connectionId).toBe('tok-2');
    expect(list[0].status).toBe('PENDING');
  });

  it('upstream 4xx is passed through; 5xx is clamped to 502', async () => {
    providerState.createError = new IntegrationProviderError('bad request', 400, '{}');
    await supertest(app)
      .post(`/api/users/${ALICE}/integrations/slack/connect`)
      .send({})
      .expect(400);

    providerState.createError = new IntegrationProviderError('upstream down', 503, '{}');
    await supertest(app)
      .post(`/api/users/${ALICE}/integrations/slack/connect`)
      .send({})
      .expect(502);
  });
});

describe('GET /api/users/:userId/integrations', () => {
  it('lists only the requested user’s connections', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'a',
      status: 'CONNECTED',
    });
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'google-mail',
      connectionId: 'b',
      status: 'PENDING',
    });
    userIntegrationsStore.upsert({
      userId: BOB,
      app: 'slack',
      connectionId: 'c',
      status: 'CONNECTED',
    });

    const res = await supertest(app).get(`/api/users/${ALICE}/integrations`).expect(200);
    const apps = res.body.integrations.map((r: { app: string }) => r.app).sort();
    expect(apps).toEqual(['google-mail', 'slack']);
    expect(res.body.integrations.every((r: { userId: string }) => r.userId === ALICE)).toBe(true);
  });

  it('cross-user GET returns 404', async () => {
    userIntegrationsStore.upsert({
      userId: BOB,
      app: 'slack',
      connectionId: 'b1',
      status: 'CONNECTED',
    });
    const res = await supertest(app).get(`/api/users/${BOB}/integrations`).expect(404);
    expect(res.body.error).toBe('Not found');
  });
});

describe('GET /api/users/:userId/integrations/:app', () => {
  it('returns the row for the caller', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'tok',
      status: 'CONNECTED',
    });
    const res = await supertest(app).get(`/api/users/${ALICE}/integrations/slack`).expect(200);
    expect(res.body.app).toBe('slack');
    expect(res.body.status).toBe('CONNECTED');
  });

  it('returns 404 when no row exists', async () => {
    await supertest(app).get(`/api/users/${ALICE}/integrations/slack`).expect(404);
  });

  it('cross-user GET returns 404 even when a row exists for the target', async () => {
    userIntegrationsStore.upsert({
      userId: BOB,
      app: 'slack',
      connectionId: 'b',
      status: 'CONNECTED',
    });
    await supertest(app).get(`/api/users/${BOB}/integrations/slack`).expect(404);
  });
});

describe('DELETE /api/users/:userId/integrations/:app', () => {
  it('happy path — calls provider then deletes the row', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'ctok',
      status: 'CONNECTED',
    });
    await supertest(app).delete(`/api/users/${ALICE}/integrations/slack`).expect(204);
    expect(providerState.deleteCalls).toEqual(['ctok']);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')).toBeNull();
  });

  it('upstream 404 is treated as idempotent success — local row is removed', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'ctok',
      status: 'CONNECTED',
    });
    providerState.deleteError = new IntegrationProviderError('gone', 404, '');
    await supertest(app).delete(`/api/users/${ALICE}/integrations/slack`).expect(204);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')).toBeNull();
  });

  it('upstream 5xx → 502 and KEEPS the local row so the user can retry', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'ctok',
      status: 'CONNECTED',
    });
    providerState.deleteError = new IntegrationProviderError('boom', 500, '');
    await supertest(app).delete(`/api/users/${ALICE}/integrations/slack`).expect(502);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')).not.toBeNull();
  });

  it('cross-user DELETE returns 404 and does NOT call provider', async () => {
    userIntegrationsStore.upsert({
      userId: BOB,
      app: 'slack',
      connectionId: 'bob-tok',
      status: 'CONNECTED',
    });
    await supertest(app).delete(`/api/users/${BOB}/integrations/slack`).expect(404);
    expect(providerState.deleteCalls).toEqual([]);
    expect(userIntegrationsStore.getForUser(BOB, 'slack')).not.toBeNull();
  });

  it('returns 404 when no row exists for caller', async () => {
    await supertest(app).delete(`/api/users/${ALICE}/integrations/slack`).expect(404);
    expect(providerState.deleteCalls).toEqual([]);
  });
});

describe('POST /api/integrations/webhooks/nango', () => {
  function sign(body: string, secret = WEBHOOK_SECRET): string {
    return crypto.createHmac('sha256', secret).update(body).digest('hex');
  }

  function authBody(opts: { app?: string; userId?: string; connectionId?: string } = {}): string {
    return JSON.stringify({
      type: 'auth',
      operation: 'creation',
      success: true,
      connectionId: opts.connectionId ?? 'nango-conn-real',
      providerConfigKey: opts.app ?? 'slack',
      endUser: { endUserId: `${HUB_INSTANCE_ID}:${opts.userId ?? ALICE}` },
    });
  }

  it('valid signature + auth.creation flips PENDING → CONNECTED', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'pending-tok',
      status: 'PENDING',
    });
    const body = authBody({});
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(200);

    const row = userIntegrationsStore.getForUser(ALICE, 'slack');
    expect(row?.status).toBe('CONNECTED');
    expect(row?.connectionId).toBe('nango-conn-real');
  });

  it('rejects missing signature with 401', async () => {
    const body = authBody({});
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .send(body)
      .expect(401);
  });

  it('rejects invalid signature with 401 (and does not mutate state)', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'pending-tok',
      status: 'PENDING',
    });
    const body = authBody({});
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', 'deadbeef')
      .send(body)
      .expect(401);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')?.status).toBe('PENDING');
  });

  it('rejects signature computed with the wrong secret', async () => {
    const body = authBody({});
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body, 'WRONG'))
      .send(body)
      .expect(401);
  });

  it('returns 404 when no webhook secret is configured (fail-closed)', async () => {
    app = buildApp({ webhookSecret: '' });
    const body = authBody({});
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(404);
  });

  it('ignores non-auth-creation events but ACKs with 200', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'pending-tok',
      status: 'PENDING',
    });
    const body = JSON.stringify({
      type: 'sync',
      operation: 'completion',
      success: true,
      connectionId: 'whatever',
      providerConfigKey: 'slack',
      endUser: { endUserId: `${HUB_INSTANCE_ID}:${ALICE}` },
    });
    const res = await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(200);
    expect(res.body.ignored).toBe(true);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')?.status).toBe('PENDING');
  });

  it('silently ignores cross-tenant payloads (different hubInstanceId prefix)', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'pending-tok',
      status: 'PENDING',
    });
    const body = JSON.stringify({
      type: 'auth',
      operation: 'creation',
      success: true,
      connectionId: 'foreign-conn',
      providerConfigKey: 'slack',
      endUser: { endUserId: `other-hub:${ALICE}` },
    });
    const res = await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(200);
    expect(res.body.ignored).toBe('cross-tenant');
    // Local row untouched.
    const row = userIntegrationsStore.getForUser(ALICE, 'slack');
    expect(row?.status).toBe('PENDING');
    expect(row?.connectionId).toBe('pending-tok');
  });

  it('rejects auth.creation payload with missing fields as 400', async () => {
    const body = JSON.stringify({
      type: 'auth',
      operation: 'creation',
      success: true,
      // missing connectionId / providerConfigKey / endUser
    });
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(400);
  });

  it('accepts the legacy `endUserId` top-level field shape', async () => {
    userIntegrationsStore.upsert({
      userId: ALICE,
      app: 'slack',
      connectionId: 'pending',
      status: 'PENDING',
    });
    const body = JSON.stringify({
      type: 'auth',
      operation: 'creation',
      success: true,
      connectionId: 'legacy-real',
      providerConfigKey: 'slack',
      endUserId: `${HUB_INSTANCE_ID}:${ALICE}`,
    });
    await supertest(app)
      .post('/api/integrations/webhooks/nango')
      .set('Content-Type', 'application/json')
      .set('X-Nango-Hmac-Sha256', sign(body))
      .send(body)
      .expect(200);
    expect(userIntegrationsStore.getForUser(ALICE, 'slack')?.status).toBe('CONNECTED');
  });
});
