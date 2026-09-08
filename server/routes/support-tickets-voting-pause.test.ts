/**
 * Per-item voting pause.
 *
 * Covers the Admin pause/resume endpoint, the `voting_paused` flag on the ticket
 * and voting-feed shapes, the vote 409 when paused, feed visibility (paused
 * items stay on the feed), input/type validation, and the Admin role gate.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import config from '../config.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { createApiKey } from '../api-keys-store.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function newProjectId(): Promise<string> {
  const project = await createProject();
  return project.id as string;
}

async function createFeatureRequest(projectId: string, body = 'add SSO'): Promise<string> {
  const res = await request
    .post(`/api/projects/${projectId}/support-tickets`)
    .send({ type: 'feature_request', body })
    .expect(201);
  return res.body.id as string;
}

function pause(projectId: string, id: string, paused: boolean) {
  return request
    .post(`/api/projects/${projectId}/support-tickets/${id}/voting-pause`)
    .send({ paused });
}

describe('feature-request voting pause', () => {
  it('defaults voting_paused to false on a new feature request and its feed item', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);

    const detail = await request
      .get(`/api/projects/${projectId}/support-tickets/${featureId}`)
      .expect(200);
    expect(detail.body.voting_paused).toBe(false);

    const feed = await request.get(`/api/projects/${projectId}/support-tickets/voting`).expect(200);
    const item = feed.body.find((t: { id: string }) => t.id === featureId);
    expect(item.voting_paused).toBe(false);
  });

  it('pausing sets the flag; the item stays on the feed but is not votable (409)', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);

    // A vote works while active.
    await request
      .put(`/api/projects/${projectId}/support-tickets/${featureId}/vote`)
      .send({ voterKey: 'voter-a', value: 1 })
      .expect(200);

    const paused = await pause(projectId, featureId, true).expect(200);
    expect(paused.body.voting_paused).toBe(true);

    // Still on the feed, flagged paused.
    const feed = await request.get(`/api/projects/${projectId}/support-tickets/voting`).expect(200);
    const item = feed.body.find((t: { id: string }) => t.id === featureId);
    expect(item).toBeTruthy();
    expect(item.voting_paused).toBe(true);

    // Every vote write is rejected while paused — cast, change, and retract.
    await request
      .put(`/api/projects/${projectId}/support-tickets/${featureId}/vote`)
      .send({ voterKey: 'voter-b', value: 1 })
      .expect(409);
    await request
      .put(`/api/projects/${projectId}/support-tickets/${featureId}/vote`)
      .send({ voterKey: 'voter-a', value: null })
      .expect(409);

    // Resume restores voting.
    const resumed = await pause(projectId, featureId, false).expect(200);
    expect(resumed.body.voting_paused).toBe(false);
    await request
      .put(`/api/projects/${projectId}/support-tickets/${featureId}/vote`)
      .send({ voterKey: 'voter-b', value: 1 })
      .expect(200);
  });

  it('rejects pause on a non-feature ticket and a non-boolean body', async () => {
    const projectId = await newProjectId();
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ type: 'bug', body: 'crash' })
      .expect(201);
    await pause(projectId, bug.body.id, true).expect(400);

    const featureId = await createFeatureRequest(projectId);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/voting-pause`)
      .send({ paused: 'yes' })
      .expect(400);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/voting-pause`)
      .send({})
      .expect(400);
  });

  it('404s for an unknown project or ticket', async () => {
    const projectId = await newProjectId();
    await pause('nope', 'whatever', true).expect(404);
    await pause(projectId, 'missing', true).expect(404);
  });
});

describe('feature-request voting pause — Admin role gate', () => {
  let originalApiKey: string | null;
  let projectId: string;
  let featureId: string;
  let userKey: string;

  beforeAll(async () => {
    originalApiKey = config.apiKey;
    config.apiKey = null;
    projectId = await newProjectId();
    featureId = await createFeatureRequest(projectId);

    const orgId = getActiveOrgId();
    const user = createUser({
      username: `fr-pause-user-${Date.now()}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(user.id, orgId, 'User');
    userKey = createApiKey(user.id, 'consumer-app').token;

    config.apiKey = 'pause-gate-secret';
  }, 60_000);

  afterAll(() => {
    config.apiKey = originalApiKey;
  });

  it('403s a User-role caller and accepts the owner API key', async () => {
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/voting-pause`)
      .set('x-api-key', userKey)
      .send({ paused: true })
      .expect(403);

    const ok = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/voting-pause`)
      .set('x-api-key', 'pause-gate-secret')
      .send({ paused: true })
      .expect(200);
    expect(ok.body.voting_paused).toBe(true);
  });
});
