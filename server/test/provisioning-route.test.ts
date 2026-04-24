/**
 * Integration tests for POST /api/projects/provision.
 *
 * These tests hit the real Express app via supertest, then drive the
 * orchestrator directly to assert the event contract. We use a stub
 * executor so no containers / git / gh are invoked.
 */
import './setup.js';
import type supertest from 'supertest';
import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { getRequest } from './helpers.js';
import {
  _resetJobsForTests,
  snapshotEvents,
  subscribeToJob,
  type ProvisioningEvent,
  type ProvisioningExecutor,
} from '../provisioning/orchestrator.js';
import {
  setProvisioningExecutorFactory,
  resetProvisioningExecutorFactory,
} from '../routes/provisioning.js';
import { getStmts } from '../db.js';

let request: supertest.Agent;

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(() => {
  _resetJobsForTests();
  resetProvisioningExecutorFactory();
});

async function waitForDone(jobId: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (snapshotEvents(jobId).some((e) => e.type === 'done')) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`Timed out waiting for done on job ${jobId}`);
}

describe('POST /api/projects/provision', () => {
  it('rejects a payload without a description', async () => {
    const res = await request.post('/api/projects/provision').send({}).expect(400);
    expect(res.body.error).toMatch(/description/i);
  });

  it('returns jobId + wsUrl + projectId and creates a dev-mode project row', async () => {
    const fake: ProvisioningExecutor = {
      async runPhase() {
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'A cool new api',
        appType: 'api',
        stack: 'express-ts-sqlite',
        integrations: ['db'],
        name: 'cool-api',
        visibility: 'private',
      })
      .expect(201);

    expect(res.body).toMatchObject({
      jobId: expect.any(String),
      wsUrl: expect.stringMatching(/^wss?:\/\/[^/]+\/api\/provisioning\/[^/]+\/events$/),
      projectId: expect.any(String),
    });

    // Project row exists and is tagged mode='dev'.
    const projectRes = await request.get(`/api/projects/${res.body.projectId}`).expect(200);
    expect(projectRes.body.mode).toBe('dev');
    expect(projectRes.body.id).toMatch(/^cool-api/);
  });

  it('drives the job to a terminal done via a fake executor', async () => {
    const fake: ProvisioningExecutor = {
      async runPhase(phase, ctx) {
        ctx.log(`fake ${phase}`);
        if (phase === 'gh-push') {
          return { status: 'ok', repoUrl: 'https://github.com/ex/x' };
        }
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'Scaffolds a thing',
        integrations: ['github'],
      })
      .expect(201);

    const jobId = res.body.jobId as string;

    // Drive the "WS" by subscribing to the same stream the WS handler uses.
    const events: ProvisioningEvent[] = [];
    subscribeToJob(jobId, (ev) => events.push(ev));

    await waitForDone(jobId);

    const done = events.find((e) => e.type === 'done') as {
      repoUrl?: string;
      error?: unknown;
    };
    expect(done).toBeDefined();
    expect(done.error).toBeUndefined();
    expect(done.repoUrl).toBe('https://github.com/ex/x');

    // Job row persisted with the terminal status.
    const row = getStmts().getProvisioningJob.get(jobId) as {
      status: string;
      repo_url: string | null;
    };
    expect(row.status).toBe('succeeded');
    expect(row.repo_url).toBe('https://github.com/ex/x');
  });

  it('emits skipped gh-* phases when the user opted out of GitHub', async () => {
    const called: string[] = [];
    const fake: ProvisioningExecutor = {
      async runPhase(phase) {
        called.push(phase);
        return { status: 'ok' };
      },
    };
    setProvisioningExecutorFactory(() => fake);

    const res = await request
      .post('/api/projects/provision')
      .send({
        description: 'Local only project',
        integrations: ['db'],
      })
      .expect(201);

    const jobId = res.body.jobId as string;
    await waitForDone(jobId);

    expect(called).not.toContain('gh-create');
    expect(called).not.toContain('gh-push');
    expect(called).not.toContain('mint-token');

    const events = snapshotEvents(jobId);
    const skipped = events.filter(
      (e) => e.type === 'phase' && (e as { status: string }).status === 'skipped',
    );
    expect(skipped.map((s) => (s as { phase: string }).phase).sort()).toEqual(
      ['gh-create', 'gh-push', 'mint-token'].sort(),
    );
  });
});

describe('GET /api/provisioning/:jobId', () => {
  it('returns 404 for unknown jobs', async () => {
    await request.get('/api/provisioning/not-a-real-id').expect(404);
  });
});
