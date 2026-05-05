/**
 * Route-level tests for the PR-env provisioning wizard.
 *
 * Mounts the router on a fresh Express app so the test doesn't require
 * `server/test/setup.ts` (which boots the full DB-backed app). The
 * mounting in `server/index.ts` itself lands with the implementation
 * card; this PR ships only the router + state machine.
 */
import express from 'express';
import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import createPrEnvProvisionRoutes from './pr-env-provision.js';
import {
  _resetJobsForTests,
  snapshotEvents,
  isJobFinished,
  type PrEnvExecutor,
} from '../pr-env-provisioning/orchestrator.js';

function buildApp(executor?: PrEnvExecutor, newJobId?: () => string) {
  const app = express();
  app.use(express.json());
  app.use(createPrEnvProvisionRoutes({ executor, newJobId }));
  return app;
}

async function waitForDone(jobId: string, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!isJobFinished(jobId)) {
    if (Date.now() > deadline) throw new Error(`job ${jobId} did not finish`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetJobsForTests();
});

describe('POST /api/settings/pr-env/provision', () => {
  it.each([
    ['previewHost', { hostedZoneId: 'Z1', repoFullName: 'a/b' }],
    ['hostedZoneId', { previewHost: 'preview.x', repoFullName: 'a/b' }],
    ['repoFullName', { previewHost: 'preview.x', hostedZoneId: 'Z1' }],
  ])('returns 400 when %s is missing', async (field, body) => {
    const app = buildApp();
    const res = await request(app).post('/api/settings/pr-env/provision').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(new RegExp(field));
  });

  it('starts a job and returns 201 with jobId + wsUrl', async () => {
    const app = buildApp(undefined, () => 'fixed-job-id');
    const res = await request(app).post('/api/settings/pr-env/provision').send({
      previewHost: 'preview.example.com',
      hostedZoneId: 'Z0123',
      repoFullName: 'acme/widgets',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      jobId: 'fixed-job-id',
      wsUrl: expect.stringMatching(
        /^wss?:\/\/[^/]+\/api\/settings\/pr-env\/provision\/fixed-job-id\/events$/,
      ),
    });

    await waitForDone('fixed-job-id');
    const events = snapshotEvents('fixed-job-id');
    expect(events.at(-1)?.type).toBe('done');
  });

  it('respects x-forwarded-proto when building wsUrl', async () => {
    const app = buildApp(undefined, () => 'tls-job');
    const res = await request(app)
      .post('/api/settings/pr-env/provision')
      .set('x-forwarded-proto', 'https')
      .send({
        previewHost: 'preview.example.com',
        hostedZoneId: 'Z0123',
        repoFullName: 'acme/widgets',
      });

    expect(res.status).toBe(201);
    expect(res.body.wsUrl).toMatch(/^wss:\/\//);
  });
});

describe('GET /api/settings/pr-env/provision/last', () => {
  it('returns {jobId: null} before any job has finished', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/settings/pr-env/provision/last');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ jobId: null });
  });

  it('returns the most-recent finished job summary', async () => {
    const app = buildApp(undefined, () => 'last-job');
    await request(app)
      .post('/api/settings/pr-env/provision')
      .send({
        previewHost: 'preview.example.com',
        hostedZoneId: 'Z0123',
        repoFullName: 'acme/widgets',
      })
      .expect(201);
    await waitForDone('last-job');

    const res = await request(app).get('/api/settings/pr-env/provision/last');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      jobId: 'last-job',
      outcome: 'ok',
      finishedAt: expect.any(String),
    });
  });
});
