import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { createRemoteRunnerBackend } from './runner-backend-remote.js';
import { getJobChannel } from './runner-job-channel.js';
import createRunnerRoutes from './runner-routes.js';
import type { RunnerLease } from './runner-backend.js';

const tick = () => new Promise((r) => setImmediate(r));
const FLEET = 'test-fleet-secret';

describe('runner-routes (HTTP control plane)', () => {
  let dir: string;
  let app: Express;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'runner-routes-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
    process.env.FINALIZE_RUNNER_FLEET_TOKEN = FLEET;
    process.env.FINALIZE_RUNNER_TOKEN_SECRET = 'test-secret';
    app = express()
      .use(express.json())
      .use(createRunnerRoutes({ claimWaitMs: 2000, pollWaitMs: 1500, leaseMs: 60_000 }));
  });

  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
    delete process.env.FINALIZE_RUNNER_FLEET_TOKEN;
    delete process.env.FINALIZE_RUNNER_TOKEN_SECRET;
  });

  const register = async (): Promise<string> => {
    const r = await request(app).post('/api/runners/register').send({ fleetToken: FLEET });
    expect(r.status).toBe(200);
    return r.body.token as string;
  };

  const SPEC = {
    orgId: 'orgA',
    projectId: 'p1',
    runId: 'r1',
    jobId: 'e2e',
    matrixKey: '',
    image: 'img:latest',
    worktreePath: '/tmp/wt',
    composeProjectName: 'cp',
    env: { FOO: 'bar' },
    labels: {},
  };

  it('rejects register with a bad fleet token and claim without an agent token', async () => {
    expect(
      (await request(app).post('/api/runners/register').send({ fleetToken: 'nope' })).status,
    ).toBe(401);
    expect((await request(app).post('/api/runners/claim').send({})).status).toBe(401);
  });

  it('full path: register → claim → poll(run_step) → logs → step-result → 410-on-release', async () => {
    const token = await register();
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 3000 });
    let lease!: RunnerLease;
    const acquireP = backend.acquire(SPEC).then((l) => (lease = l));

    const claim = await request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(claim.status).toBe(200);
    const jobId = claim.body.jobId as string;
    expect(claim.body.spec.jobId).toBe('e2e');
    expect(claim.body.spec.env).toEqual({ FOO: 'bar' });

    // The poll must actually be in flight for the channel to attach (which
    // unblocks acquire); Promise.all fires it concurrently with acquire+spawn.
    let step!: ReturnType<RunnerLease['spawnStep']>;
    const [poll] = await Promise.all([
      request(app)
        .post(`/api/runners/jobs/${jobId}/poll`)
        .set('Authorization', `Bearer ${token}`)
        .send(),
      (async () => {
        await acquireP;
        step = lease.spawnStep({
          step: { name: 's', run: 'echo hi' },
          index: 0,
          cwd: '/tmp/wt',
          env: { FOO: 'bar' },
        });
      })(),
    ]);
    expect(poll.body).toEqual({
      type: 'run_step',
      stepIndex: 0,
      run: 'echo hi',
      env: { FOO: 'bar' },
    });

    let out = '';
    step.stdout!.on('data', (d) => (out += d.toString()));
    const closes: Array<number | null> = [];
    step.on('close', (c) => closes.push(c));
    await request(app)
      .post(`/api/runners/jobs/${jobId}/logs`)
      .set('Authorization', `Bearer ${token}`)
      .send({ frames: [{ seq: 0, stepIndex: 0, stream: 'stdout', data: 'hi\n' }] });
    await request(app)
      .post(`/api/runners/jobs/${jobId}/step-result`)
      .set('Authorization', `Bearer ${token}`)
      .send({ stepIndex: 0, exitCode: 0 });
    await tick();
    expect(out).toBe('hi\n');
    expect(closes).toEqual([0]);

    // Release disposes the channel; the agent's next poll gets 410 = "job done,
    // tear down" (the reliable teardown signal, race-free vs the finish directive).
    await lease.release();
    expect(getJobChannel(jobId)).toBeUndefined();
    const gone = await request(app)
      .post(`/api/runners/jobs/${jobId}/poll`)
      .set('Authorization', `Bearer ${token}`)
      .send();
    expect(gone.status).toBe(410);
  });

  it("forbids another agent from touching a job it didn't claim (403)", async () => {
    const tokenA = await register();
    const tokenB = await register();
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 3000 });
    let lease!: RunnerLease;
    const acquireP = backend.acquire(SPEC).then((l) => (lease = l));

    const claim = await request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({});
    const jobId = claim.body.jobId as string;

    // Fire agent A's poll (attaches → unblocks acquire) concurrently.
    const [, forbidden] = await Promise.all([
      request(app)
        .post(`/api/runners/jobs/${jobId}/poll`)
        .set('Authorization', `Bearer ${tokenA}`)
        .send(),
      (async () => {
        await acquireP;
        // Agent B never claimed this job → forbidden.
        const res = await request(app)
          .post(`/api/runners/jobs/${jobId}/logs`)
          .set('Authorization', `Bearer ${tokenB}`)
          .send({ frames: [] });
        await lease.release();
        return res;
      })(),
    ]);
    expect(forbidden.status).toBe(403);
  });
});
