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

  it("denying moves the request into the Won't Do pile; re-approving restores it", async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);

    // Deny → status flips to wont_do (preserved, not lost) with a reason, and
    // the request surfaces under the wont_do filter rather than vanishing.
    const denied = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'denied' })
      .expect(200);
    expect(denied.body.approval_status).toBe('denied');
    expect(denied.body.status).toBe('wont_do');
    expect(denied.body.wont_do_reason).toBe('Feature request denied');

    const wontDoIds = await request
      .get(`/api/projects/${projectId}/support-tickets?status=wont_do`)
      .expect(200)
      .then((r) => r.body.map((t: { id: string }) => t.id));
    expect(wontDoIds).toContain(featureId);

    // Re-approving pulls it back to the open queue and clears the reason, keeping
    // the wont_do_reason invariant (non-null only while status is wont_do).
    const approved = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'approved' })
      .expect(200);
    expect(approved.body.approval_status).toBe('approved');
    expect(approved.body.status).toBe('new');
    expect(approved.body.wont_do_reason).toBeNull();
    expect(await listIds(projectId)).toContain(featureId);
  });

  it('denying a converted request does not clobber its terminal status', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId);
    // Drive it to a terminal, non-wont_do status directly.
    getDb().prepare("UPDATE support_tickets SET status = 'converted' WHERE id = ?").run(featureId);

    const denied = await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'denied' })
      .expect(200);
    expect(denied.body.approval_status).toBe('denied');
    // Still converted — a denial never rewrites an already-terminal lifecycle.
    expect(denied.body.status).toBe('converted');
    expect(denied.body.wont_do_reason).toBeNull();
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

describe('main-queue approval filter (?approval=)', () => {
  // Helper: list ids with an explicit status + approval bucket.
  function listIdsWith(
    projectId: string,
    query: { status?: string; approval?: string },
  ): Promise<string[]> {
    const params = new URLSearchParams();
    if (query.status) params.set('status', query.status);
    if (query.approval) params.set('approval', query.approval);
    return request
      .get(`/api/projects/${projectId}/support-tickets?${params.toString()}`)
      .expect(200)
      .then((r) => r.body.map((t: { id: string }) => t.id));
  }

  it('defaults to approved and switches buckets when voting is enabled', async () => {
    const projectId = await newProjectId();
    const pendingId = await createFeatureRequest(projectId, 'pending req');
    const approvedId = await createFeatureRequest(projectId, 'approved req');
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ type: 'bug', body: 'crash' })
      .expect(201);
    const bugId = bug.body.id as string;

    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);
    await request
      .post(`/api/projects/${projectId}/support-tickets/${approvedId}/approval`)
      .send({ status: 'approved' })
      .expect(200);

    // Default (no approval param) = approved bucket + all non-feature tickets.
    const def = await listIdsWith(projectId, {});
    expect(def).toContain(approvedId);
    expect(def).toContain(bugId);
    expect(def).not.toContain(pendingId);

    // ?approval=approved is identical to the default.
    expect(await listIdsWith(projectId, { approval: 'approved' })).toEqual(def);

    // ?approval=pending swaps to pending feature requests; the bug (non-feature)
    // is never gated so it still shows, and the approved one drops out.
    const pending = await listIdsWith(projectId, { approval: 'pending' });
    expect(pending).toContain(pendingId);
    expect(pending).toContain(bugId);
    expect(pending).not.toContain(approvedId);
  });

  it('surfaces denied (rejected) feature requests under the Won’t Do status', async () => {
    const projectId = await newProjectId();
    const featureId = await createFeatureRequest(projectId, 'denied req');
    await request
      .patch(`/api/projects/${projectId}`)
      .send({ voting: { enabled: true } })
      .expect(200);
    // Deny moves the open request to wont_do (terminal), so it needs the
    // wont_do status scope combined with the denied approval bucket.
    await request
      .post(`/api/projects/${projectId}/support-tickets/${featureId}/approval`)
      .send({ status: 'denied' })
      .expect(200);

    expect(await listIdsWith(projectId, { status: 'wont_do', approval: 'denied' })).toContain(
      featureId,
    );
    // The approved bucket over the same status scope excludes it.
    expect(await listIdsWith(projectId, { status: 'wont_do', approval: 'approved' })).not.toContain(
      featureId,
    );
  });

  it('ignores the approval param entirely when voting is off', async () => {
    const projectId = await newProjectId();
    const pendingId = await createFeatureRequest(projectId, 'classic req');
    // Voting off (default): a pending feature request appears regardless of the
    // approval param — no gating at all.
    expect(await listIdsWith(projectId, { approval: 'approved' })).toContain(pendingId);
    expect(await listIdsWith(projectId, { approval: 'denied' })).toContain(pendingId);
  });

  it('rejects an invalid approval value with 400', async () => {
    const projectId = await newProjectId();
    await request.get(`/api/projects/${projectId}/support-tickets?approval=sideways`).expect(400);
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
