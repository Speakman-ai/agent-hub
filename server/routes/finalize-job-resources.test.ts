/**
 * Integration tests for `GET /api/projects/:projectId/finalize/:runId/job-resources`.
 *
 * Seeds per-job resource metrics via the same emitter the runner finish route
 * uses, then asserts the read endpoint groups them into one entry per
 * (job_name, matrix_key) with peak memory + peak CPU joined.
 */
import '../test/setup.js';
import type supertest from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { getRequest } from '../test/helpers.js';
import { getStmts } from '../db.js';
import { recordJobResourceSummary } from '../finalize/metrics.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

async function freshProject(): Promise<string> {
  const id = `jobres-test-${uuidv4().slice(0, 8)}`;
  await request
    .post('/api/projects')
    .send({ id, name: id, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);
  return id;
}

describe('GET /api/projects/:projectId/finalize/:runId/job-resources', () => {
  it('404 when the project does not exist', async () => {
    const res = await request
      .get('/api/projects/no-such-project/finalize/r1/job-resources')
      .expect(404);
    expect(res.body.error).toMatch(/project not found/i);
  });

  it('returns an empty jobs list for a run with no reported resources', async () => {
    const projectId = await freshProject();
    const res = await request
      .get(`/api/projects/${projectId}/finalize/run-with-nothing/job-resources`)
      .expect(200);
    expect(res.body).toMatchObject({ project_id: projectId, run_id: 'run-with-nothing', jobs: [] });
  });

  it('groups peak memory + peak CPU per (job_name, matrix_key)', async () => {
    const projectId = await freshProject();
    const runId = `run-${uuidv4().slice(0, 8)}`;
    const stmts = getStmts();

    recordJobResourceSummary(
      { stmts },
      {
        projectId,
        runId,
        jobName: 'e2e',
        matrixKey: 'MLS & Routing',
        summary: {
          peakMemBytes: 1_700_000_000,
          memTotalBytes: 32_000_000_000,
          peakCpuPercent: 72.5,
          avgCpuPercent: 18,
          samples: 9,
          durationMs: 45_000,
        },
      },
    );
    recordJobResourceSummary(
      { stmts },
      {
        projectId,
        runId,
        jobName: 'unit',
        matrixKey: '',
        summary: {
          peakMemBytes: 800_000_000,
          memTotalBytes: 32_000_000_000,
          peakCpuPercent: null, // no CPU sample → only the memory metric emits
          avgCpuPercent: null,
          samples: 4,
          durationMs: 12_000,
        },
      },
    );

    const res = await request
      .get(`/api/projects/${projectId}/finalize/${runId}/job-resources`)
      .expect(200);

    expect(res.body.jobs).toHaveLength(2);
    const e2e = res.body.jobs.find((j: { job_name: string }) => j.job_name === 'e2e');
    expect(e2e).toMatchObject({
      job_name: 'e2e',
      matrix_key: 'MLS & Routing',
      peak_mem_bytes: 1_700_000_000,
      mem_total_bytes: 32_000_000_000,
      peak_cpu_percent: 72.5,
    });
    const unit = res.body.jobs.find((j: { job_name: string }) => j.job_name === 'unit');
    expect(unit).toMatchObject({
      job_name: 'unit',
      matrix_key: '',
      peak_mem_bytes: 800_000_000,
      peak_cpu_percent: null,
    });
  });
});
