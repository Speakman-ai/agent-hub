/**
 * Integration tests for /api/mcp-servers and /api/mcp-catalog. Two users
 * (`userA`, `userB`) verify the per-user-scoping invariant — userB MUST NOT
 * see, mutate, or even probe the existence of userA's rows.
 */
import './setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { mkdirSync } from 'fs';

import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId, getOrgsDb } from '../orgs.js';
import {
  MASK,
  __setMcpServersKeyFilePathForTests,
  ensureMcpServersSchema,
} from '../mcp-servers-store.js';

interface TUser {
  id: string;
  username: string;
  jwt: string;
}

let request: supertest.Agent;
let userA: TUser;
let userB: TUser;

function issueJwt(jwtSecret: string, user: { id: string; username: string }): string {
  return signJwt(user.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: user.id },
  });
}

beforeAll(async () => {
  // Pin the encryption key so the routes-test run doesn't write to a key
  // path that the unit-test run uses.
  const keyDir = path.join(os.tmpdir(), `mcp-routes-test-${process.pid}`);
  mkdirSync(keyDir, { recursive: true });
  __setMcpServersKeyFilePathForTests(path.join(keyDir, 'mcp-routes.key'));

  request = await getRequest();
  ensureMcpServersSchema();

  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'mcp-routes-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();
  const aRow = createUser({
    username: `mcp-user-a-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const bRow = createUser({
    username: `mcp-user-b-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(aRow.id, orgId, 'Admin');
  createMembership(bRow.id, orgId, 'Admin');

  userA = { id: aRow.id, username: aRow.username, jwt: issueJwt(jwtSecret, aRow) };
  userB = { id: bRow.id, username: bRow.username, jwt: issueJwt(jwtSecret, bRow) };
}, 60_000);

beforeEach(() => {
  // Wipe rows owned by either test user between tests so list assertions are
  // deterministic. Other tests' rows (under different user_ids) are left alone.
  getOrgsDb()
    .prepare('DELETE FROM mcp_servers WHERE user_id = ? OR user_id = ?')
    .run(userA.id, userB.id);
});

describe('GET /api/mcp-catalog', () => {
  it('returns the v1 catalog (Linear, Notion, GitHub)', async () => {
    const res = await request
      .get('/api/mcp-catalog')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    const ids = (res.body.entries as Array<{ id: string }>).map((e) => e.id).sort();
    expect(ids).toEqual(['github', 'linear', 'notion']);
  });
});

describe('POST /api/mcp-servers', () => {
  it('creates a row scoped to the authenticated user', async () => {
    const res = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({
        name: 'Linear',
        catalogId: 'linear',
        transport: 'http',
        url: 'https://mcp.linear.app/sse',
        headers: { Authorization: 'Bearer lin_api_xxx' },
      })
      .expect(201);

    expect(res.body.server.name).toBe('Linear');
    expect(res.body.server.headers).toEqual({ Authorization: MASK });
    expect(res.body.server.userId).toBe(userA.id);
  });

  it('400s when transport is missing/invalid', async () => {
    await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'X', transport: 'invalid' })
      .expect(400);
  });

  it('400s when stdio transport has no command', async () => {
    await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'X', transport: 'stdio' })
      .expect(400);
  });

  it('400s when http transport has no url', async () => {
    await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'X', transport: 'http' })
      .expect(400);
  });

  it('401s without auth', async () => {
    await request
      .post('/api/mcp-servers')
      .send({ name: 'X', transport: 'http', url: 'https://x/' })
      .expect(401);
  });
});

describe('GET /api/mcp-servers', () => {
  it('only returns rows owned by the authenticated user', async () => {
    const aRes = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'A-server', transport: 'http', url: 'https://a/' })
      .expect(201);
    await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userB.jwt}`)
      .send({ name: 'B-server', transport: 'http', url: 'https://b/' })
      .expect(201);

    const aList = await request
      .get('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    const aIds = (aList.body.servers as Array<{ id: string }>).map((s) => s.id);
    expect(aIds).toEqual([aRes.body.server.id]);

    const bList = await request
      .get('/api/mcp-servers')
      .set('Authorization', `Bearer ${userB.jwt}`)
      .expect(200);
    expect((bList.body.servers as Array<{ name: string }>).map((s) => s.name)).toEqual([
      'B-server',
    ]);
  });
});

describe('PUT /api/mcp-servers/:id', () => {
  it('updates a row owned by the caller', async () => {
    const created = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'X', transport: 'http', url: 'https://x/' })
      .expect(201);

    const updated = await request
      .put(`/api/mcp-servers/${created.body.server.id}`)
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ enabled: false, name: 'X-renamed' })
      .expect(200);

    expect(updated.body.server.name).toBe('X-renamed');
    expect(updated.body.server.enabled).toBe(false);
  });

  it('404s when the row belongs to another user (does not leak existence)', async () => {
    const created = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'A-only', transport: 'http', url: 'https://x/' })
      .expect(201);

    await request
      .put(`/api/mcp-servers/${created.body.server.id}`)
      .set('Authorization', `Bearer ${userB.jwt}`)
      .send({ name: 'hacked' })
      .expect(404);
  });

  it('404s for an unknown id', async () => {
    await request
      .put('/api/mcp-servers/mcp_does_not_exist')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'x' })
      .expect(404);
  });
});

describe('DELETE /api/mcp-servers/:id', () => {
  it('deletes a row owned by the caller', async () => {
    const created = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'doomed', transport: 'http', url: 'https://x/' })
      .expect(201);

    await request
      .delete(`/api/mcp-servers/${created.body.server.id}`)
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);

    const list = await request
      .get('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    expect((list.body.servers as Array<{ id: string }>).map((s) => s.id)).not.toContain(
      created.body.server.id,
    );
  });

  it("404s when deleting another user's row", async () => {
    const created = await request
      .post('/api/mcp-servers')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'A-only', transport: 'http', url: 'https://x/' })
      .expect(201);

    await request
      .delete(`/api/mcp-servers/${created.body.server.id}`)
      .set('Authorization', `Bearer ${userB.jwt}`)
      .expect(404);
  });
});
