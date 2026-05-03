/**
 * End-to-end coverage for the per-user API keys feature
 * (POST/GET/DELETE /api/auth/keys + auth-middleware lookup).
 */
import './setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';

import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId, getOrgsDb, initOrgsDb } from '../orgs.js';
import { createApiKey, hashToken, verifyApiKey, listApiKeys } from '../api-keys-store.js';
import config from '../config.js';

interface User {
  id: string;
  username: string;
  jwt: string;
}

let request: supertest.Agent;
let userA: User;
let userB: User;

function issueJwt(jwtSecret: string, user: { id: string; username: string }): string {
  return signJwt(user.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Admin', uid: user.id },
  });
}

beforeAll(async () => {
  request = await getRequest();

  // Persist a JWT-style auth record so the middleware enforces auth
  // (otherwise it free-passes when neither apiKey nor authRecord is set).
  void path.join(config.dataDir, 'auth.json'); // imported only for parity
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'apikey-owner',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  const orgId = getActiveOrgId();
  const aRow = createUser({
    username: `apikey-user-a-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const bRow = createUser({
    username: `apikey-user-b-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(aRow.id, orgId, 'Admin');
  createMembership(bRow.id, orgId, 'Admin');

  userA = { id: aRow.id, username: aRow.username, jwt: issueJwt(jwtSecret, aRow) };
  userB = { id: bRow.id, username: bRow.username, jwt: issueJwt(jwtSecret, bRow) };
}, 60_000);

describe('api_keys schema', () => {
  it('migration is idempotent — running initOrgsDb twice does not throw', () => {
    expect(() => initOrgsDb()).not.toThrow();
    const cols = getOrgsDb().prepare("PRAGMA table_info('api_keys')").all() as Array<{
      name: string;
    }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'user_id',
        'name',
        'token_hash',
        'prefix',
        'created_at',
        'last_used_at',
        'revoked_at',
        'expires_at',
      ]),
    );
  });
});

describe('hashToken / verifyApiKey', () => {
  it('produces a stable SHA-256 hex digest', () => {
    const a = hashToken('ahub_example');
    const b = hashToken('ahub_example');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects malformed tokens without a DB lookup', () => {
    expect(verifyApiKey('not-a-token')).toBeNull();
    expect(verifyApiKey('')).toBeNull();
    expect(verifyApiKey('ahub_short')).toBeNull();
    // Bearer JWTs should never be misinterpreted as an api key.
    expect(verifyApiKey('eyJhbGciOiJIUzI1NiJ9.x.y')).toBeNull();
  });

  it('verifies a real token and returns the owner', () => {
    const created = createApiKey(userA.id, 'unit-test-key');
    const verified = verifyApiKey(created.token);
    expect(verified).toEqual({ userId: userA.id, keyId: created.id });
  });

  it('rejects an expired key', () => {
    const created = createApiKey(userA.id, 'expired-key');
    // Backdate the expiry directly in the DB to dodge the "1 day minimum"
    // validation while still exercising the middleware's expiry check.
    getOrgsDb()
      .prepare("UPDATE api_keys SET expires_at = datetime('now', '-1 hour') WHERE id = ?")
      .run(created.id);
    expect(verifyApiKey(created.token)).toBeNull();
  });
});

describe('POST /api/auth/keys', () => {
  it('creates a key and returns the plaintext token exactly once', async () => {
    const res = await request
      .post('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'CI runner' })
      .expect(201);
    expect(res.body.token).toMatch(/^ahub_[A-Za-z0-9_-]{40,}$/);
    expect(res.body.name).toBe('CI runner');
    expect(res.body.prefix).toBe(res.body.token.slice(0, 12));

    // Subsequent GET must NOT include the plaintext token.
    const list = await request
      .get('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    const found = list.body.keys.find((k: { id: string }) => k.id === res.body.id);
    expect(found).toBeDefined();
    expect(found.token).toBeUndefined();
    expect(found.token_hash).toBeUndefined();
  });

  it('rejects empty / oversize names', async () => {
    await request
      .post('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: '' })
      .expect(400);
    await request
      .post('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'x'.repeat(101) })
      .expect(400);
  });

  it('rejects out-of-range expiresInDays', async () => {
    await request
      .post('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'bad-ttl', expiresInDays: 0 })
      .expect(400);
    await request
      .post('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .send({ name: 'bad-ttl', expiresInDays: 4000 })
      .expect(400);
  });

  it('requires authentication', async () => {
    await request.post('/api/auth/keys').send({ name: 'no-auth' }).expect(401);
  });
});

describe('Auth via Authorization: Bearer ahub_*', () => {
  it('grants access to a protected endpoint', async () => {
    const created = createApiKey(userA.id, 'bearer-test');
    const res = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${created.token}`)
      .expect(200);
    expect(res.body.user.username).toBe(userA.username);
  });

  it('grants access via X-API-Key header', async () => {
    const created = createApiKey(userA.id, 'xapikey-test');
    const res = await request.get('/api/auth/me').set('X-API-Key', created.token).expect(200);
    expect(res.body.user.username).toBe(userA.username);
  });

  it('updates last_used_at on first use', async () => {
    const created = createApiKey(userA.id, 'last-used-test');
    const before = listApiKeys(userA.id).find((k) => k.id === created.id)?.lastUsedAt;
    expect(before).toBeNull();
    await request.get('/api/auth/me').set('Authorization', `Bearer ${created.token}`).expect(200);
    const after = listApiKeys(userA.id).find((k) => k.id === created.id)?.lastUsedAt;
    expect(after).not.toBeNull();
  });

  it('rejects revoked keys', async () => {
    const created = createApiKey(userA.id, 'to-revoke');
    await request
      .delete(`/api/auth/keys/${created.id}`)
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    await request.get('/api/auth/me').set('Authorization', `Bearer ${created.token}`).expect(401);
  });
});

describe('DELETE /api/auth/keys/:id', () => {
  it("404s when the key isn't owned by the caller", async () => {
    const created = createApiKey(userA.id, 'a-only');
    await request
      .delete(`/api/auth/keys/${created.id}`)
      .set('Authorization', `Bearer ${userB.jwt}`)
      .expect(404);
    // Original key still works for userA.
    const res = await request
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${created.token}`)
      .expect(200);
    expect(res.body.user.username).toBe(userA.username);
  });

  it('hides revoked keys from the list endpoint', async () => {
    const created = createApiKey(userA.id, 'will-be-hidden');
    await request
      .delete(`/api/auth/keys/${created.id}`)
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    const list = await request
      .get('/api/auth/keys')
      .set('Authorization', `Bearer ${userA.jwt}`)
      .expect(200);
    expect(list.body.keys.find((k: { id: string }) => k.id === created.id)).toBeUndefined();
  });
});
