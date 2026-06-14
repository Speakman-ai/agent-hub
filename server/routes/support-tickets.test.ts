import { describe, it, expect, beforeAll, vi } from 'vitest';
import type supertest from 'supertest';
import { getRequest, createProject } from '../test/helpers.js';

// Stub the investigation trigger so creating a bug ticket in these tests never
// spawns a CLI (the real fire-and-forget path would shell out to an engine).
// We still assert it is wired correctly below.
const triggerInvestigation = vi.fn();
vi.mock('../support-ticket-investigation.js', () => ({
  triggerSupportTicketInvestigation: (...args: unknown[]) => triggerInvestigation(...args),
}));

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
}, 60_000);

async function newProjectId(): Promise<string> {
  const project = await createProject();
  return project.id as string;
}

describe('support-tickets routes', () => {
  it('404s for an unknown project', async () => {
    await request.get('/api/projects/does-not-exist/support-tickets').expect(404);
    await request
      .post('/api/projects/does-not-exist/support-tickets')
      .send({ body: 'x' })
      .expect(404);
  });

  it('creates, lists (severity-ordered), filters, patches, and deletes', async () => {
    const projectId = await newProjectId();

    // Empty queue to start.
    const empty = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(empty.body).toEqual([]);

    // Create in scrambled severity order.
    for (const severity of ['low', 'critical', 'medium', 'high']) {
      await request
        .post(`/api/projects/${projectId}/support-tickets`)
        .send({ body: `a ${severity} ticket`, severity, type: 'bug' })
        .expect(201);
    }

    const list = await request.get(`/api/projects/${projectId}/support-tickets`).expect(200);
    expect(list.body.map((t: { severity: string }) => t.severity)).toEqual([
      'critical',
      'high',
      'medium',
      'low',
    ]);

    const critical = list.body.find((t: { severity: string }) => t.severity === 'critical');
    expect(critical.status).toBe('new');

    // Patch: move to investigating + attach AI investigation.
    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${critical.id}`)
      .send({ status: 'investigating', aiSummary: 'looking into it' })
      .expect(200);
    expect(patched.body.status).toBe('investigating');
    expect(patched.body.ai_summary).toBe('looking into it');
    expect(patched.body.ai_investigated_at).not.toBeNull();

    // Status filter.
    const investigating = await request
      .get(`/api/projects/${projectId}/support-tickets?status=investigating`)
      .expect(200);
    expect(investigating.body).toHaveLength(1);
    expect(investigating.body[0].id).toBe(critical.id);

    // Single fetch.
    await request.get(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(200);

    // Delete.
    await request.delete(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(200);
    await request.get(`/api/projects/${projectId}/support-tickets/${critical.id}`).expect(404);
  });

  it('PATCH preserves AI fields not present in the body (partial update)', async () => {
    const projectId = await newProjectId();
    const created = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'webhook fails', severity: 'high' })
      .expect(201);
    const id = created.body.id as string;

    // Seed both AI fields.
    await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ aiSummary: 'summary v1', aiInvestigation: 'details v1' })
      .expect(200);

    // Send only the summary — the investigation text must survive.
    const patched = await request
      .patch(`/api/projects/${projectId}/support-tickets/${id}`)
      .send({ aiSummary: 'summary v2' })
      .expect(200);
    expect(patched.body.ai_summary).toBe('summary v2');
    expect(patched.body.ai_investigation).toBe('details v1');
  });

  it('rejects a missing body and invalid status filter', async () => {
    const projectId = await newProjectId();
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ severity: 'high' })
      .expect(400);
    await request.get(`/api/projects/${projectId}/support-tickets?status=bogus`).expect(400);
  });

  it('triggers AI investigation for bug tickets only', async () => {
    const projectId = await newProjectId();

    triggerInvestigation.mockClear();
    const bug = await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'crash on save', type: 'bug', severity: 'high' })
      .expect(201);
    expect(triggerInvestigation).toHaveBeenCalledTimes(1);
    expect(triggerInvestigation).toHaveBeenCalledWith(
      bug.body.id,
      expect.objectContaining({ cwd: expect.any(String) }),
    );

    // Non-bug ticket types do not kick off an investigation.
    triggerInvestigation.mockClear();
    await request
      .post(`/api/projects/${projectId}/support-tickets`)
      .send({ body: 'how do I export?', type: 'question' })
      .expect(201);
    expect(triggerInvestigation).not.toHaveBeenCalled();
  });
});
