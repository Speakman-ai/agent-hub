/**
 * Integration tests for the Finalize↔GitHub parity routes. Drives the live
 * Express app via supertest so routing, the prepared-statement seam, the
 * upsert, and the read aggregation are exercised as production does it.
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
  const id = `parity-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:projectId/finalize/parity', () => {
  it('404 when the project does not exist', async () => {
    await request.get('/api/projects/does-not-exist/finalize/parity').expect(404);
  });

  it('returns an empty dataset with a zeroed summary', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: '24h' })
      .expect(200);
    expect(res.body.records).toEqual([]);
    expect(res.body.summary).toMatchObject({ total: 0, false_green: 0 });
  });

  it('400 on an invalid range', async () => {
    const projectId = await freshProject();
    await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: 'nonsense' })
      .expect(400);
  });

  it('400 on an invalid class filter', async () => {
    const projectId = await freshProject();
    await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ class: 'green' })
      .expect(400);
  });
});

describe('POST /api/projects/:projectId/finalize/parity', () => {
  it('records a false_green observation and surfaces it in the list + summary', async () => {
    const projectId = await freshProject();
    const post = await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({
        commit_sha: '6ad87ec',
        pr_number: 1001,
        finalize_verdict: 'green',
        finalize_jobs: [{ name: 'backend', state: 'green' }],
        github_verdict: 'red',
        github_jobs: [{ name: 'backend', state: 'red' }],
        note: 'manual',
      })
      .expect(201);
    expect(post.body.record.divergence_class).toBe('false_green');

    const list = await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: '24h' })
      .expect(200);
    expect(list.body.summary.false_green).toBe(1);
    expect(list.body.records).toHaveLength(1);
    expect(list.body.records[0].commit_sha).toBe('6ad87ec');
  });

  it('is idempotent on commit_sha (re-post updates in place)', async () => {
    const projectId = await freshProject();
    const body = {
      commit_sha: 'dupe',
      finalize_verdict: 'green',
      github_verdict: 'red',
    };
    await request.post(`/api/projects/${projectId}/finalize/parity`).send(body).expect(201);
    await request.post(`/api/projects/${projectId}/finalize/parity`).send(body).expect(201);
    const list = await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: '24h' })
      .expect(200);
    expect(list.body.records).toHaveLength(1);
  });

  it('filters the record list by class while keeping a full-window summary', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({ commit_sha: 'green1', finalize_verdict: 'green', github_verdict: 'green' })
      .expect(201);
    await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({ commit_sha: 'fg1', finalize_verdict: 'green', github_verdict: 'red' })
      .expect(201);

    const filtered = await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: '24h', class: 'false_green' })
      .expect(200);
    expect(filtered.body.records).toHaveLength(1);
    expect(filtered.body.records[0].commit_sha).toBe('fg1');
    // Summary reflects the full window, not the filter.
    expect(filtered.body.summary.total).toBe(2);
    expect(filtered.body.summary.agree_green).toBe(1);
    expect(filtered.body.summary.false_green).toBe(1);
  });

  it('400 when commit_sha is missing', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({ finalize_verdict: 'green', github_verdict: 'red' })
      .expect(400);
  });

  it('400 on an invalid verdict', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({ commit_sha: 'x', finalize_verdict: 'maybe', github_verdict: 'red' })
      .expect(400);
  });

  it('400 on a malformed job entry', async () => {
    const projectId = await freshProject();
    await request
      .post(`/api/projects/${projectId}/finalize/parity`)
      .send({
        commit_sha: 'x',
        finalize_verdict: 'green',
        github_verdict: 'red',
        github_jobs: [{ name: 'backend', state: 'exploded' }],
      })
      .expect(400);
  });
});

describe('POST /api/projects/:projectId/finalize/parity/seed', () => {
  it('seeds PR#1001 as the first false_green', async () => {
    const projectId = await freshProject();
    const res = await request.post(`/api/projects/${projectId}/finalize/parity/seed`).expect(201);
    expect(res.body.seeded).toBeGreaterThanOrEqual(1);
    const pr1001 = (res.body.records as Array<Record<string, unknown>>).find(
      (r) => r.pr_number === 1001,
    );
    expect(pr1001).toBeDefined();
    expect(pr1001?.divergence_class).toBe('false_green');

    const list = await request
      .get(`/api/projects/${projectId}/finalize/parity`)
      .query({ range: '24h', class: 'false_green' })
      .expect(200);
    expect(list.body.records.some((r: Record<string, unknown>) => r.commit_sha === '6ad87ec')).toBe(
      true,
    );
  });
});
