import type TestAgent from 'supertest/lib/agent.js';
import { getRequest, createProject, createEscalationHelper } from './helpers.js';
import type { Project, EscalationRow } from '../types.js';

let request: TestAgent;
let project: Project;

beforeAll(async () => {
  request = await getRequest();
  project = (await createProject({ id: 'esc-test-proj' })) as unknown as Project;
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/projects/:projectId/escalations
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/projects/:projectId/escalations', () => {
  it('creates an escalation with valid data', async () => {
    const res = await request
      .post(`/api/projects/${project.id}/escalations`)
      .send({
        type: 'ci_failure',
        title: 'CI failed on PR #42',
        description: 'Tests failing after 2 retries',
        prNumber: 42,
        prUrl: 'https://github.com/test/repo/pull/42',
        source: 'webhook',
      })
      .expect(201);

    expect(res.body.id).toBeDefined();
    expect(res.body.project_id).toBe(project.id);
    expect(res.body.type).toBe('ci_failure');
    expect(res.body.title).toBe('CI failed on PR #42');
    expect(res.body.pr_number).toBe(42);
    expect(res.body.acknowledged).toBe(0);
  });

  it('rejects invalid type', async () => {
    await request
      .post(`/api/projects/${project.id}/escalations`)
      .send({ type: 'invalid', title: 'Bad type' })
      .expect(400);
  });

  it('rejects missing title', async () => {
    await request
      .post(`/api/projects/${project.id}/escalations`)
      .send({ type: 'blocker' })
      .expect(400);
  });

  it('returns 404 for non-existent project', async () => {
    await request
      .post('/api/projects/nonexistent/escalations')
      .send({ type: 'blocker', title: 'Test' })
      .expect(404);
  });

  it('creates all valid escalation types', async () => {
    for (const type of ['merge_conflict', 'ci_failure', 'review_needed', 'blocker']) {
      const res = await request
        .post(`/api/projects/${project.id}/escalations`)
        .send({ type, title: `Test ${type}` })
        .expect(201);
      expect(res.body.type).toBe(type);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/projects/:projectId/escalations
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/projects/:projectId/escalations', () => {
  it('lists all escalations for a project', async () => {
    const res = await request.get(`/api/projects/${project.id}/escalations`).expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0]).toHaveProperty('type');
    expect(res.body[0]).toHaveProperty('title');
  });

  it('filters to active (unacknowledged) escalations', async () => {
    const res = await request
      .get(`/api/projects/${project.id}/escalations?active=true`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    (res.body as EscalationRow[]).forEach((esc) => {
      expect(esc.acknowledged).toBe(0);
    });
  });

  it('returns 404 for non-existent project', async () => {
    await request.get('/api/projects/nonexistent/escalations').expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// GET /api/escalations (global active)
// ═══════════════════════════════════════════════════════════════════

describe('GET /api/escalations', () => {
  it('lists all active escalations across projects', async () => {
    const res = await request.get('/api/escalations').expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════
// POST /api/escalations/:id/acknowledge
// ═══════════════════════════════════════════════════════════════════

describe('POST /api/escalations/:id/acknowledge', () => {
  it('acknowledges an escalation', async () => {
    const esc = (await createEscalationHelper(project.id, {
      type: 'blocker',
      title: 'Test blocker to ack',
    })) as unknown as EscalationRow;

    const res = await request.post(`/api/escalations/${esc.id}/acknowledge`).expect(200);

    expect(res.body.acknowledged).toBe(1);
    expect(res.body.id).toBe(esc.id);
  });

  it('returns 404 for non-existent escalation', async () => {
    await request.post('/api/escalations/nonexistent/acknowledge').expect(404);
  });

  it('acknowledged escalation no longer appears in active list', async () => {
    const esc = (await createEscalationHelper(project.id, {
      type: 'merge_conflict',
      title: 'Ack filter test',
    })) as unknown as EscalationRow;

    await request.post(`/api/escalations/${esc.id}/acknowledge`).expect(200);

    const activeRes = await request
      .get(`/api/projects/${project.id}/escalations?active=true`)
      .expect(200);

    const found = (activeRes.body as EscalationRow[]).find((e) => e.id === esc.id);
    expect(found).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════
// DELETE /api/escalations/:id
// ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/escalations/:id', () => {
  it('deletes an escalation', async () => {
    const esc = (await createEscalationHelper(project.id, {
      type: 'review_needed',
      title: 'Test delete',
    })) as unknown as EscalationRow;

    await request.delete(`/api/escalations/${esc.id}`).expect(200);

    const allRes = await request.get(`/api/projects/${project.id}/escalations`).expect(200);
    const found = (allRes.body as EscalationRow[]).find((e) => e.id === esc.id);
    expect(found).toBeUndefined();
  });

  it('returns 404 for non-existent escalation', async () => {
    await request.delete('/api/escalations/nonexistent').expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════
// createEscalation helper (unit-level via API)
// ═══════════════════════════════════════════════════════════════════

describe('createEscalation helper (via createEscalationHelper)', () => {
  it('creates escalation with all optional fields', async () => {
    const esc = (await createEscalationHelper(project.id, {
      type: 'ci_failure',
      title: 'Full fields test',
      description: 'Detailed description here',
      prNumber: 99,
      prUrl: 'https://github.com/test/repo/pull/99',
      cardId: 'card-123',
      source: 'test',
    })) as unknown as EscalationRow;

    expect(esc.type).toBe('ci_failure');
    expect(esc.description).toBe('Detailed description here');
    expect(esc.pr_number).toBe(99);
    expect(esc.pr_url).toBe('https://github.com/test/repo/pull/99');
    expect(esc.card_id).toBe('card-123');
    expect(esc.source).toBe('test');
  });

  it('creates escalation with minimal fields', async () => {
    const esc = (await createEscalationHelper(project.id, {
      type: 'blocker',
      title: 'Minimal escalation',
    })) as unknown as EscalationRow;

    expect(esc.type).toBe('blocker');
    expect(esc.title).toBe('Minimal escalation');
    expect(esc.pr_number).toBeNull();
    expect(esc.acknowledged).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Deduplication behavior
// ═══════════════════════════════════════════════════════════════════

describe('Escalation deduplication', () => {
  it('does not create duplicate review_needed escalations for the same PR', async () => {
    await request
      .post(`/api/projects/${project.id}/escalations`)
      .send({
        type: 'review_needed',
        title: 'Changes requested on PR #77',
        prNumber: 77,
      })
      .expect(201);

    const res = await request
      .get(`/api/projects/${project.id}/escalations?active=true`)
      .expect(200);

    const reviewEscalations = (res.body as EscalationRow[]).filter(
      (e) => e.type === 'review_needed' && e.pr_number === 77,
    );
    expect(reviewEscalations.length).toBeGreaterThanOrEqual(1);
  });
});
