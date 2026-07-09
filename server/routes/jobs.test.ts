/**
 * Job admin routes — live app via supertest. Rows are seeded through the
 * JobQueue against the shared app db (getDb()) so the real schema is used.
 *
 * Auth: the default test harness runs in the legacy "no auth configured"
 * mode where the caller is treated as Owner, so the requireRole('Admin')
 * gate passes without headers (same pattern as config.db-stats.test.ts).
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getRequest } from '../test/helpers.js';
import { getDb } from '../db.js';
import { JobQueue } from '../jobs/job-queue.js';
import { getJobRow } from '../jobs/admin.js';
import type { JobStatus } from '../jobs/job-queue.js';
import { randomUUID } from 'crypto';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

function makeQueue(): JobQueue {
  return new JobQueue({ db: getDb(), log: () => {} });
}

beforeEach(() => {
  // Clean slate: the jobs table is host-wide, so wipe it between tests.
  getDb().prepare('DELETE FROM jobs').run();
});

/**
 * Insert a job row directly at a chosen status. Seeding via the queue's
 * claim/process path is racy (claim() picks the oldest queued row, not
 * necessarily the one just enqueued), so we write the row explicitly.
 */
function seedJob(type: string, status: JobStatus, overrides: Record<string, unknown> = {}): string {
  const id = randomUUID();
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO jobs (id, type, payload, status, priority, attempts, max_attempts, run_at,
                         last_error, created_at, updated_at)
       VALUES (@id, @type, '{}', @status, 0, @attempts, 5, @now, @lastError, @now, @now)`,
    )
    .run({
      id,
      type,
      status,
      attempts: status === 'dead_letter' ? 5 : 0,
      lastError: status === 'dead_letter' ? 'boom' : null,
      now,
      ...overrides,
    });
  return id;
}

describe('GET /api/jobs', () => {
  it('lists jobs with counts and distinct types', async () => {
    const q = makeQueue();
    q.enqueue('alpha');
    q.enqueue('beta');

    const res = await request.get('/api/jobs').expect(200);
    expect(res.body.jobs.length).toBe(2);
    expect(res.body.counts.queued).toBe(2);
    expect(res.body.counts.total).toBe(2);
    expect(res.body.types).toEqual(['alpha', 'beta']);
    expect(res.body.limit).toBe(50);
    expect(res.body.offset).toBe(0);
  });

  it('filters by status and by type', async () => {
    const q = makeQueue();
    q.enqueue('alpha');
    q.enqueue('alpha');
    const deadId = seedJob('boomer', 'dead_letter');

    const byType = await request.get('/api/jobs?type=alpha').expect(200);
    expect(byType.body.jobs.every((j: any) => j.type === 'alpha')).toBe(true);
    expect(byType.body.jobs.length).toBe(2);

    const dead = await request.get('/api/jobs?status=dead_letter').expect(200);
    expect(dead.body.jobs.length).toBe(1);
    expect(dead.body.jobs[0].id).toBe(deadId);
  });

  it('rejects an invalid status filter with 400', async () => {
    const res = await request.get('/api/jobs?status=bogus').expect(400);
    expect(res.body.error).toMatch(/Invalid status/);
  });

  it('clamps limit to the max', async () => {
    const res = await request.get('/api/jobs?limit=99999').expect(200);
    expect(res.body.limit).toBe(200);
  });
});

describe('POST /api/jobs/:id/retry', () => {
  it('requeues a dead-lettered job', async () => {
    const id = seedJob('boomer', 'dead_letter');
    expect(getJobRow(getDb(), id)!.status).toBe('dead_letter');

    const res = await request.post(`/api/jobs/${id}/retry`).expect(200);
    expect(res.body.job.status).toBe('queued');
    expect(res.body.job.attempts).toBe(0);
    expect(res.body.job.last_error).toBeNull();
    expect(getJobRow(getDb(), id)!.status).toBe('queued');
  });

  it('404s for an unknown job', async () => {
    await request.post('/api/jobs/does-not-exist/retry').expect(404);
  });

  it('409s when the job is not dead-lettered', async () => {
    const q = makeQueue();
    const id = q.enqueue('alpha');
    const res = await request.post(`/api/jobs/${id}/retry`).expect(409);
    expect(res.body.error).toMatch(/dead-lettered/);
  });
});

describe('DELETE /api/jobs/:id', () => {
  it('deletes a job row', async () => {
    const q = makeQueue();
    const id = q.enqueue('alpha');
    await request.delete(`/api/jobs/${id}`).expect(200);
    expect(getJobRow(getDb(), id)).toBeUndefined();
  });

  it('404s for an unknown job', async () => {
    await request.delete('/api/jobs/nope').expect(404);
  });
});
