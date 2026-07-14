/**
 * Log-store metrics route tests. Runs against the real Express app (supertest);
 * `../test/setup.js` installs the no-real-CLI and live-network guards. Ingests
 * through the real batch-writer queue, drains it, then reads the metrics
 * endpoint back and asserts the published counters/gauges.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, it, expect } from 'vitest';
import { getRequest, createProject } from '../test/helpers.js';
import { flushLogWriteQueue } from '../logs/log-write-queue.js';
import { resetLogMetrics } from '../logs/log-metrics.js';

let request: supertest.Agent;
let projectId: string;
let token: string;

beforeAll(async () => {
  request = await getRequest();
  const project = await createProject({ cwd: '/tmp' });
  projectId = project.id as string;
  const src = await request
    .post(`/api/projects/${projectId}/log-sources`)
    .send({ name: 'metrics-src', serviceName: 'checkout', environment: 'prod' })
    .expect(201);
  token = src.body.token as string;
});

describe('GET /api/projects/:projectId/logs/metrics', () => {
  it('publishes queue, counters, latency, and storage gauges', async () => {
    resetLogMetrics();
    // Ingest three records; one oversize so `rejected` moves too.
    await request
      .post('/api/logs/ingest')
      .set({ Authorization: `Bearer ${token}` })
      .set('Content-Type', 'application/json')
      .send(
        JSON.stringify({
          records: [{ message: 'm-a' }, { message: 'm-b' }, { message: 'a'.repeat(300 * 1024) }],
        }),
      )
      .expect(200);
    // Drain so `written` and `dbBytes` reflect the batch deterministically.
    flushLogWriteQueue();

    const res = await request.get(`/api/projects/${projectId}/logs/metrics`).expect(200);
    const { queue, counters, latency, storage } = res.body;

    expect(queue).toMatchObject({ depth: expect.any(Number), depthLimit: expect.any(Number) });
    expect(counters.accepted).toBe(2); // 2 admitted (oversize rejected pre-queue)
    expect(counters.written).toBe(2);
    expect(counters.rejected).toBe(1); // the oversize record
    expect(latency.flushCount).toBeGreaterThanOrEqual(1);
    expect(storage.projectBytes).toBeGreaterThan(0);
    expect(storage.dbBytes).toBeGreaterThan(0);
    expect(storage.retentionDays).toBeGreaterThan(0);
    expect(storage.retentionLagRecords).toBe(0);
  });

  it('404s an unknown project (existence not leaked)', async () => {
    await request.get('/api/projects/does-not-exist/logs/metrics').expect(404);
  });
});
