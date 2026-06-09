/**
 * Integration tests for the Finalize quarantine + flake routes. Drives the
 * live Express app via supertest so routing, validation, the prepared-statement
 * seam, and the read aggregation are exercised as production does it.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `quarantine-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:projectId/finalize/quarantine', () => {
  it('404 when the project does not exist', async () => {
    await request.get('/api/projects/does-not-exist/finalize/quarantine').expect(404);
  });

  it('returns empty active/overdue buckets for a fresh project', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/finalize/quarantine`).expect(200);
    expect(res.body.active).toEqual([]);
    expect(res.body.overdue).toEqual([]);
    expect(res.body.max_days).toBe(30);
    expect(res.body.default_days).toBe(30);
  });
});

describe('POST /api/projects/:projectId/finalize/quarantine', () => {
  it('400 without job_id', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ owner: 'alice' })
      .expect(400);
  });

  it('400 without owner', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e' })
      .expect(400);
  });

  it('400 on non-numeric days', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e', owner: 'alice', days: 'soon' })
      .expect(400);
  });

  it('creates an entry, clamps days to ≤30, and surfaces it as active', async () => {
    const projectId = await freshProject();
    const created = await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e', owner: 'alice', reason: 'flaky login', days: 999 })
      .expect(201);
    expect(created.body.entry.job_id).toBe('e2e');
    expect(created.body.entry.owner).toBe('alice');
    expect(created.body.entry.status).toBe('active');
    // 999 clamped to 30 days → days_until_expiry should be 29 or 30.
    expect(created.body.entry.days_until_expiry).toBeLessThanOrEqual(30);
    expect(created.body.entry.days_until_expiry).toBeGreaterThanOrEqual(29);

    const list = await request.get(`/api/projects/${projectId}/finalize/quarantine`).expect(200);
    expect(list.body.active).toHaveLength(1);
    expect(list.body.active[0].job_id).toBe('e2e');
  });

  it('is idempotent per instance (re-quarantining the same job updates in place)', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e', owner: 'alice' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e', owner: 'bob' })
      .expect(201);
    const list = await request.get(`/api/projects/${projectId}/finalize/quarantine`).expect(200);
    expect(list.body.active).toHaveLength(1);
    expect(list.body.active[0].owner).toBe('bob');
  });
});

describe('DELETE /api/projects/:projectId/finalize/quarantine/:id', () => {
  it('releases an entry and 404s on a second delete', async () => {
    const projectId = await freshProject();
    const created = await request
      .post(`/api/projects/${projectId}/finalize/quarantine`)
      .send({ job_id: 'e2e', owner: 'alice' })
      .expect(201);
    const id = created.body.entry.id;
    await request.delete(`/api/projects/${projectId}/finalize/quarantine/${id}`).expect(204);
    await request.delete(`/api/projects/${projectId}/finalize/quarantine/${id}`).expect(404);
    const list = await request.get(`/api/projects/${projectId}/finalize/quarantine`).expect(200);
    expect(list.body.active).toEqual([]);
  });
});

describe('GET /api/projects/:projectId/finalize/flakes', () => {
  it('404 when the project does not exist', async () => {
    await request.get('/api/projects/does-not-exist/finalize/flakes').expect(404);
  });

  it('400 on a non-positive windowDays', async () => {
    const projectId = await freshProject();
    await request
      .get(`/api/projects/${projectId}/finalize/flakes`)
      .query({ windowDays: '-1' })
      .expect(400);
  });

  it('400 on a fractional windowDays (contract declares an integer)', async () => {
    const projectId = await freshProject();
    await request
      .get(`/api/projects/${projectId}/finalize/flakes`)
      .query({ windowDays: '1.5' })
      .expect(400);
  });

  it('returns an empty instance list for a project with no history', async () => {
    const projectId = await freshProject();
    const res = await request.get(`/api/projects/${projectId}/finalize/flakes`).expect(200);
    expect(res.body.instances).toEqual([]);
    expect(res.body.window_days).toBe(30);
  });
});
