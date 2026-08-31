/**
 * Survey-Tracker-facing voting API auth (P2). The voting feed is reachable
 * with the standard Hub X-API-Key (global config.apiKey); a request with no
 * credentials is rejected. An X-API-Key-only caller (no Hub user) receives the
 * external-safe projection.
 */
import './setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest } from './helpers.js';
import config from '../config.js';
import { recordSupportTicketInvestigation } from '../support-tickets-store.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { createApiKey } from '../api-keys-store.js';

const API_KEY = 'voting-external-secret';
let request: supertest.Agent;
let projectId: string;
let ticketId: string;
let originalApiKey: string | null;
let userApiKey: string;

beforeAll(async () => {
  request = await getRequest();
  originalApiKey = config.apiKey;

  // Seed with auth open so project + ticket creation is not gated.
  config.apiKey = null;
  const project = await request
    .post('/api/projects')
    .send({ id: `voting-auth-${Date.now()}`, name: 'Voting Auth', cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  projectId = project.body.id as string;

  const ticket = await request
    .post(`/api/projects/${projectId}/support-tickets`)
    .send({
      type: 'feature_request',
      body: 'add SSO',
      reporter_email: 'reporter@example.com',
    })
    .expect(201);
  ticketId = ticket.body.id as string;
  // Populate operator-only fields so the projection has something to strip.
  recordSupportTicketInvestigation(ticketId, {
    summary: 'operator summary',
    details: 'operator investigation',
  });

  // A per-user `ahub_*` key: owned by a real user with a membership role.
  // The card permits Survey Tracker to present one, so it must be treated as
  // an external caller even though it carries an authUserId.
  const orgId = getActiveOrgId();
  const user = createUser({
    username: `voting-key-owner-${Date.now()}@example.com`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(user.id, orgId, 'Admin');
  userApiKey = createApiKey(user.id, 'survey-tracker').token;

  // Enable the global X-API-Key so the middleware enforces auth.
  config.apiKey = API_KEY;
}, 60_000);

afterAll(() => {
  config.apiKey = originalApiKey;
});

describe('voting API — X-API-Key auth', () => {
  it('rejects the voting feed with no credentials (401)', async () => {
    await request.get(`/api/projects/${projectId}/support-tickets/voting`).expect(401);
  });

  it('accepts the global X-API-Key and returns the external-safe projection', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/support-tickets/voting`)
      .set('x-api-key', API_KEY)
      .expect(200);

    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(item.id).toBe(ticketId);
    expect(item).toHaveProperty('voting');
    // Operator-only fields are stripped for the API-key-only caller.
    expect(item).not.toHaveProperty('reporter_email');
    expect(item).not.toHaveProperty('ai_summary');
    expect(item).not.toHaveProperty('ai_investigation');
    expect(item).not.toHaveProperty('release_state');
  });

  it('treats a per-user ahub_* key as external (safe projection, not the full row)', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/support-tickets/voting`)
      .set('x-api-key', userApiKey)
      .expect(200);

    expect(res.body).toHaveLength(1);
    const item = res.body[0];
    expect(item.id).toBe(ticketId);
    expect(item).toHaveProperty('voting');
    // A per-user key carries an authUserId but is still an API request, so
    // operator-only fields must be stripped.
    expect(item).not.toHaveProperty('reporter_email');
    expect(item).not.toHaveProperty('ai_summary');
    expect(item).not.toHaveProperty('ai_investigation');
    expect(item).not.toHaveProperty('release_state');
  });

  it('rejects a vote write with no credentials (401)', async () => {
    await request
      .put(`/api/projects/${projectId}/support-tickets/${ticketId}/vote`)
      .send({ voterKey: 'a', value: 1 })
      .expect(401);
  });

  it('accepts a vote write with the X-API-Key', async () => {
    const res = await request
      .put(`/api/projects/${projectId}/support-tickets/${ticketId}/vote`)
      .set('x-api-key', API_KEY)
      .send({ voterKey: 'survey-tracker-token', value: 1 })
      .expect(200);
    expect(res.body.score).toBe(1);
    expect(res.body.upvotes).toBe(1);
  });

  it('rejects listing comments with no credentials (401)', async () => {
    await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}/comments`)
      .expect(401);
  });

  it('rejects posting a comment with no credentials (401)', async () => {
    await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/comments`)
      .send({ body: 'unauthenticated' })
      .expect(401);
  });

  it('accepts a comment post with the X-API-Key (source: external)', async () => {
    const res = await request
      .post(`/api/projects/${projectId}/support-tickets/${ticketId}/comments`)
      .set('x-api-key', API_KEY)
      .send({ body: 'from survey tracker' })
      .expect(201);
    expect(res.body.body).toBe('from survey tracker');
    // API-key-only callers post as `external`; the projection omits hidden_at.
    expect(res.body.source).toBe('external');
    expect(res.body).not.toHaveProperty('hidden_at');
  });

  it('accepts listing comments with the X-API-Key', async () => {
    const res = await request
      .get(`/api/projects/${projectId}/support-tickets/${ticketId}/comments`)
      .set('x-api-key', API_KEY)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((c: { body: string }) => c.body === 'from survey tracker')).toBe(true);
    // External projection never exposes the moderation timestamp.
    for (const comment of res.body) {
      expect(comment).not.toHaveProperty('hidden_at');
    }
  });
});
