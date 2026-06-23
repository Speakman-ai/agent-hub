import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { enqueueRunnerJob, reapExpiredRunnerLeases } from './runner-queue.js';
import { createRemoteRunnerBackend } from './runner-backend-remote.js';
import { getJobChannel } from './runner-job-channel.js';
import createRunnerRoutes, {
  parseResourceSummary,
  type JobResourcesEvent,
} from './runner-routes.js';
import type { RunnerLease } from './runner-backend.js';

const tick = () => new Promise((r) => setImmediate(r));
const FLEET = 'test-fleet-secret';

describe('parseResourceSummary', () => {
  it('accepts a well-formed summary', () => {
    expect(
      parseResourceSummary({
        peakMemBytes: 100,
        memTotalBytes: 200,
        peakCpuPercent: 50,
        avgCpuPercent: 10,
        samples: 3,
        durationMs: 5000,
      }),
    ).toEqual({
      peakMemBytes: 100,
      memTotalBytes: 200,
      peakCpuPercent: 50,
      avgCpuPercent: 10,
      samples: 3,
      durationMs: 5000,
    });
  });

  it('preserves null CPU and defaults samples/duration', () => {
    const r = parseResourceSummary({
      peakMemBytes: 1,
      memTotalBytes: 2,
      peakCpuPercent: null,
      avgCpuPercent: null,
    });
    expect(r).toMatchObject({
      peakCpuPercent: null,
      avgCpuPercent: null,
      samples: 0,
      durationMs: 0,
    });
  });

  it.each([
    null,
    undefined,
    'nope',
    {},
    { peakMemBytes: -1, memTotalBytes: 2 },
    { peakMemBytes: 1, memTotalBytes: 0 },
    { peakMemBytes: 'x', memTotalBytes: 2 },
  ])('rejects malformed input %j', (bad) => {
    expect(parseResourceSummary(bad)).toBeNull();
  });
});

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

  it('heartbeat with spotInterruption=true stamps the job so a lost lease is a known reclaim', async () => {
    const token = await register();
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      specJson: '{}',
      now: Date.now(),
    });
    const claim = await request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(claim.status).toBe(200);
    const jobId = claim.body.jobId as string;

    // End-to-end through express.json() parsing: the real transport body shape.
    const hb = await request(app)
      .post(`/api/runners/jobs/${jobId}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({ spotInterruption: true });
    expect(hb.status).toBe(204);

    const row = getOrgsDb()
      .prepare('SELECT spot_interruption_at FROM runner_jobs WHERE id=?')
      .get(jobId) as { spot_interruption_at: number | null };
    expect(row.spot_interruption_at).not.toBeNull();

    // And the consequence: a later lease expiry is classified as a reclaim.
    expect(reapExpiredRunnerLeases(Date.now() + 10 * 60_000)).toEqual([
      { id: jobId, spotReclaimed: true },
    ]);
  });

  it('heartbeat without the flag does not stamp a spot interruption', async () => {
    const token = await register();
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      specJson: '{}',
      now: Date.now(),
    });
    const claim = await request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const jobId = claim.body.jobId as string;
    const hb = await request(app)
      .post(`/api/runners/jobs/${jobId}/heartbeat`)
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(hb.status).toBe(204);
    const row = getOrgsDb()
      .prepare('SELECT spot_interruption_at FROM runner_jobs WHERE id=?')
      .get(jobId) as { spot_interruption_at: number | null };
    expect(row.spot_interruption_at).toBeNull();
  });

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

  it('reports a job resource summary on finish, resolved to its run/job context', async () => {
    const events: JobResourcesEvent[] = [];
    const cbApp = express()
      .use(express.json())
      .use(
        createRunnerRoutes({
          claimWaitMs: 2000,
          pollWaitMs: 1500,
          leaseMs: 60_000,
          onJobResources: (e) => events.push(e),
        }),
      );
    const r = await request(cbApp).post('/api/runners/register').send({ fleetToken: FLEET });
    const token = r.body.token as string;
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 3000 });
    let lease!: RunnerLease;
    const acquireP = backend.acquire(SPEC).then((l) => (lease = l));
    const claim = await request(cbApp)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const jobId = claim.body.jobId as string;
    await Promise.all([
      request(cbApp)
        .post(`/api/runners/jobs/${jobId}/poll`)
        .set('Authorization', `Bearer ${token}`)
        .send(),
      acquireP,
    ]);

    const finish = await request(cbApp)
      .post(`/api/runners/jobs/${jobId}/finish`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        exitCode: 0,
        resourceSummary: {
          peakMemBytes: 1_700_000_000,
          memTotalBytes: 32_000_000_000,
          peakCpuPercent: 72.5,
          avgCpuPercent: 18.1,
          samples: 9,
          durationMs: 45_000,
        },
      });
    expect(finish.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      projectId: 'p1',
      runId: 'r1',
      jobName: 'e2e',
      matrixKey: '',
      summary: { peakMemBytes: 1_700_000_000, peakCpuPercent: 72.5 },
    });
    await lease.release();
  });

  it('finish without a resource summary is a clean 204 (no callback)', async () => {
    const events: JobResourcesEvent[] = [];
    const cbApp = express()
      .use(express.json())
      .use(
        createRunnerRoutes({
          claimWaitMs: 2000,
          pollWaitMs: 1500,
          leaseMs: 60_000,
          onJobResources: (e) => events.push(e),
        }),
      );
    const r = await request(cbApp).post('/api/runners/register').send({ fleetToken: FLEET });
    const token = r.body.token as string;
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 3000 });
    let lease!: RunnerLease;
    const acquireP = backend.acquire(SPEC).then((l) => (lease = l));
    const claim = await request(cbApp)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    const jobId = claim.body.jobId as string;
    await Promise.all([
      request(cbApp)
        .post(`/api/runners/jobs/${jobId}/poll`)
        .set('Authorization', `Bearer ${token}`)
        .send(),
      acquireP,
    ]);
    const finish = await request(cbApp)
      .post(`/api/runners/jobs/${jobId}/finish`)
      .set('Authorization', `Bearer ${token}`)
      .send({ exitCode: 0 });
    expect(finish.status).toBe(204);
    expect(events).toHaveLength(0);
    await lease.release();
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
