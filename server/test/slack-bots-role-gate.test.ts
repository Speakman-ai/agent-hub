/**
 * Role-gating coverage for the DB-backed Slack bot management API.
 *
 * The mutating routes (POST/PUT/DELETE /api/slack/bots, toggle, test) are
 * all guarded by `requireRole('Admin')`. The happy path (Owner) is covered
 * by `slack-bots.test.ts`; this file pins the gate itself by exercising
 * the User → 403 and unauthenticated → 401 paths.
 *
 * Why a dedicated file: setup.ts deletes AGENT_HUB_API_KEY and the default
 * `slack-bots.test.ts` runs without an auth record, which makes
 * authMiddleware short-circuit to Owner. Here we install a real authRecord
 * + create a non-Admin user so requireRole has something below the bar to
 * reject.
 */

import { vi, describe, it, expect, beforeAll } from 'vitest';

vi.mock('../slack.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slack.js')>();
  return {
    ...actual,
    restartSlack: vi.fn().mockResolvedValue(undefined),
    getSlackStatus: vi.fn(() => []),
    getSlackMessages: vi.fn(() => []),
    getAllSlackMessages: vi.fn(() => []),
  };
});

import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';

let request: supertest.Agent;
let userJwt: string;
let adminJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'slack-role-test-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();

  const userRow = createUser({
    username: `slack-role-test-user-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(userRow.id, orgId, 'User');
  userJwt = signJwt(userRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: userRow.id },
  });

  const adminRow = createUser({
    username: `slack-role-test-admin-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(adminRow.id, orgId, 'Admin');
  adminJwt = signJwt(adminRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: adminRow.id },
  });
}, 60_000);

describe('Slack bot routes — requireRole(Admin) gate', () => {
  it('POST /api/slack/bots — User role gets 403', async () => {
    const res = await request
      .post('/api/slack/bots')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({
        name: 'forbidden-bot',
        bot_token: 'xoxb-x',
        app_token: 'xapp-x',
        agent_id: 'a',
      });
    expect(res.status).toBe(403);
    expect(res.body.requiredRole).toBe('Admin');
    expect(res.body.currentRole).toBe('User');
  });

  it('PUT /api/slack/bots/:id — User role gets 403 (gate fires before 404 on missing row)', async () => {
    const res = await request
      .put('/api/slack/bots/nonexistent-id')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ name: 'whatever' });
    expect(res.status).toBe(403);
  });

  it('DELETE /api/slack/bots/:id — User role gets 403', async () => {
    const res = await request
      .delete('/api/slack/bots/nonexistent-id')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/slack/bots/:id/toggle — User role gets 403', async () => {
    const res = await request
      .post('/api/slack/bots/nonexistent-id/toggle')
      .set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(403);
  });

  it('POST /api/slack/bots/:id/test — User role gets 403', async () => {
    const res = await request
      .post('/api/slack/bots/nonexistent-id/test')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({});
    expect(res.status).toBe(403);
  });

  it('POST /api/slack/bots — unauthenticated request gets 401', async () => {
    const res = await request.post('/api/slack/bots').send({
      name: 'no-auth-bot',
      bot_token: 'xoxb-x',
      app_token: 'xapp-x',
      agent_id: 'a',
    });
    expect(res.status).toBe(401);
  });

  it('POST /api/slack/bots — Admin role passes the gate (smoke test)', async () => {
    const res = await request
      .post('/api/slack/bots')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        name: `admin-pass-${Date.now()}`,
        bot_token: 'xoxb-x',
        app_token: 'xapp-x',
        agent_id: 'a',
      });
    // Admin satisfies requireRole('Admin') → handler runs → 201.
    expect(res.status).toBe(201);
    if (res.body?.id) {
      await request
        .delete(`/api/slack/bots/${res.body.id}`)
        .set('Authorization', `Bearer ${adminJwt}`);
    }
  });
});

describe('Slack bot routes — read paths remain ungated', () => {
  // GET /api/slack/bots is intentionally readable by any authenticated user
  // (tokens are masked on the response). The role gate only sits on
  // mutating routes — pin that contract too so a future "lock everything
  // down" refactor doesn't accidentally tighten reads without updating the
  // UI's read-only admin panel.
  it('GET /api/slack/bots — User role can read masked list', async () => {
    const res = await request.get('/api/slack/bots').set('Authorization', `Bearer ${userJwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
