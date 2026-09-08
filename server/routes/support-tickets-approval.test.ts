/**
 * Feature-request approval workflow (Project.voting.enabled).
 *
 * Covers the admin approve/deny endpoint, the main-queue visibility gate, the
 * voting-feed denied filter, the per-project toggle, and the Admin role gate.
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
import { getDb } from '../db.js';

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

function listIds(projectId: string): Promise<string[]> {
  return request
    .get(`/api/projects/${projectId}/support-tickets`)
    .expect(200)
    .then((r) => r.body.map((t: { id: string }) => t.id));
}

function votingIds(projectId: string): Promise<string[]> {
  return request
    .get(`/api/projects/${projectId}/support-tickets/voting`)
    .expect(200)
    .then((r) => r.body.map((t: { id: string }) => t.id));
}

describe('feature-request approval workflow', () => {
  it('stamps new feature requests as pending and leaves other types null', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ type: 'bug', body: 'crash' })
      .expect(201);

    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    const feature = list.body.find((t: { id: string }) => t.id === featureId);
    const bugRow = list.body.find((t: { id: string }) => t.id === bug.body.id);
    expect(feature.approval_status).toBe('pending');
    expect(bugRow.approval_status).toBeNull();
  });

  it('hides pending feature requests from the queue only when voting is enabled', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);

    // Toggle OFF (default): the pending feature request shows classically.
    expect(await listIds(projectId)).toContain(featureId);

    // Enable the voting/approval system: pending requests leave the queue.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);
    expect(await listIds(projectId)).not.toContain(featureId);

    // ...but stay on the public voting feed so customers can keep voting.
    expect(await votingIds(projectId)).toContain(featureId);
  });

  it('approve surfaces the request in the queue; deny drops it from queue and feed', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);

    // Approve → back in the queue, stamped.
    const approved = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'approved' })
      .expect(200);
    expect(approved.body.approval_status).toBe('approved');
    expect(approved.body.approved_at).toBeTruthy();
    expect(await listIds(projectId)).toContain(featureId);
    expect(await votingIds(projectId)).toContain(featureId);

    // Deny → gone from the queue AND the voting feed; timestamps cleared on reset.
    const denied = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'denied' })
      .expect(200);
    expect(denied.body.approval_status).toBe('denied');
    expect(await listIds(projectId)).not.toContain(featureId);
    expect(await votingIds(projectId)).not.toContain(featureId);

    // Reset to pending clears the decision stamp.
    const reset = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'pending' })
      .expect(200);
    expect(reset.body.approval_status).toBe('pending');
    expect(reset.body.approved_at).toBeNull();
    expect(reset.body.approved_by).toBeNull();
  });

  it('rejects approval on a non-feature ticket and an invalid status', async () => {
    const projectId = await newProjectId();
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ type: 'bug', body: 'crash' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${bug.body.id}/approval`)
      .send({ status: 'approved' })
      .expect(400);

    const featureId = await createFeatureRequest(projectId);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'sideways' })
      .expect(400);
  });

  it('normalizes a legacy NULL feature request to pending in the response', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);
    // Simulate a row created before the approval column existed.
    getDb()
      .prepare('UPDATE support_tickets SET approval_status = NULL WHERE id = ?')
      .run(featureId);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);

    // The voting feed still surfaces it (NULL is not denied), presented as
    // 'pending' so the Admin approve/deny controls render for it.
    const feed = await request.get(`/api/projects/${projectId}/support-tickets/voting`).expect(200);
    const item = feed.body.find((t: { id: string }) => t.id === featureId);
    expect(item).toBeTruthy();
    expect(item.approval_status).toBe('pending');

    // It's still gated out of the main queue until approved.
    expect(await listIds(projectId)).not.toContain(featureId);

    // And it can be approved through the endpoint like any pending request.
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'approved' })
      .expect(200);
    expect(await listIds(projectId)).toContain(featureId);
  });

  it('rejects an invalid voting toggle and leaves the persisted value unchanged', async () => {
    const projectId = await newProjectId();

    const votingEnabled = () =>
      request
        .get(`/api/projects/${projectId}`)
        .expect(200)
        .then((r) => Boolean(r.body.voting?.enabled));

    // From the default (off) state, malformed payloads are rejected...
    expect(await votingEnabled()).toBe(false);
    await request.patch(`/api/projects/${projectId}`).send({ voting: 'yes' }).expect(400);
    await request.patch(`/api/projects/${projectId}`).send({ voting: [] }).expect(400);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: 'true' } })
      .expect(400);
    // ...and none of them flipped the toggle.
    expect(await votingEnabled()).toBe(false);

    // From the on state, a rejected payload must not turn it back off.
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);
    expect(await votingEnabled()).toBe(true);
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: 1 } })
      .expect(400);
    expect(await votingEnabled()).toBe(true);
  });

  it('404s for an unknown project or ticket', async () => {
    const projectId = await newProjectId();
    await request
      .post(`/api/projects/nope/support-tickets/whatever/approval`)
      .send({ status: 'approved' })
      .expect(404);
    await request
      .post(`/api/projects/${projectId}/support-tickets/missing/approval`)
      .send({ status: 'approved' })
      .expect(404);
  });
});

describe('feature-request approval — Admin role gate', () => {
  let originalApiKey: string | null;
  let projectId: string;
  let featureId: string;
  let userKey: string;

  beforeAll(async () => {
    originalApiKey = config.apiKey;
    // Seed with auth open so setup isn't gated.
    config.apiKey = null;
    projectId = await newProjectId();
    featureId = await createFeatureRequest(projectId);

    // A per-user ahub_* key owned by a plain User — below Admin.
    const orgId = getActiveOrgId();
    const user = createUser({
      username: `fr-approval-user-${Date.now()}@example.com`,
      passwordHash: 'h',
      createdAt: '2026-01-01T00:00:00Z',
    });
    createMembership(user.id, orgId, 'User');
    userKey = createApiKey(user.id, 'consumer-app').token;

    // Enforce auth for the assertions below.
    config.apiKey = 'approval-gate-secret';
  }, 60_000);

  afterAll(() => {
    config.apiKey = originalApiKey;
  });

  it('403s a User-role caller and accepts the owner API key', async () => {
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .set('x-api-key', userKey)
      .send({ status: 'approved' })
      .expect(403);

    // The break-glass owner key counts as Owner — approval works "via API".
    const ok = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .set('x-api-key', 'approval-gate-secret')
      .send({ status: 'approved' })
      .expect(200);
    expect(ok.body.approval_status).toBe('approved');
    expect(ok.body.approved_by).toBe('api-key');
  });
});
