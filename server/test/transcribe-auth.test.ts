/**
 * Auth gate for POST /api/transcribe.
 *
 * The web client's MessageInput must send Bearer (or X-API-Key) on this
 * route. Without credentials, authMiddleware returns 401 on multi-user
 * deployments — the bug fixed in MessageInput.jsx.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';

let request: supertest.Agent;
let ownerJwt: string;

beforeAll(async () => {
  request = await getRequest();

  const jwtSecret = generateJwtSecret();
  const ownerRow = createUser({
    username: `transcribe-auth-test-owner-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-05-26T00:00:00Z',
  });
  createMembership(ownerRow.id, getActiveOrgId(), 'Owner');

  saveAuthRecord({
    username: ownerRow.username,
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });

  ownerJwt = signJwt(ownerRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Owner', uid: ownerRow.id },
  });
}, 60_000);

describe('POST /api/transcribe — authMiddleware', () => {
  it('returns 401 when no credential is sent', async () => {
    const res = await request
      .post('/api/transcribe')
      .set('content-type', 'audio/webm')
      .send(Buffer.from('fake-audio'));
    expect(res.status).toBe(401);
  });

  it('passes auth with a Bearer token (501 when OpenAI key unset)', async () => {
    const res = await request
      .post('/api/transcribe')
      .set('Authorization', `Bearer ${ownerJwt}`)
      .set('content-type', 'audio/webm')
      .send(Buffer.from('fake-audio'));
    // 501 = route reached, transcription not configured — not 401.
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/not configured/i);
  });
});
