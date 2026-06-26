import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import express, { type Express } from 'express';
import request from 'supertest';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { enqueueRunnerJob, reapExpiredRunnerLeases } from './runner-queue.js';

// Mock Hub-driven task protection: by default the arm/clear calls resolve
// instantly ('skipped'), so every existing test is unaffected; the await-race
// test below overrides arm with a deferred promise to assert the claim handler
// blocks on it.
vi.mock('./hub-task-protection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./hub-task-protection.js')>();
  return {
    ...actual,
    armHubTaskProtection: vi.fn(async () => 'skipped' as const),
    clearHubTaskProtection: vi.fn(async () => 'skipped' as const),
  };
});
import { armHubTaskProtection } from './hub-task-protection.js';
import { createRemoteRunnerBackend } from './runner-backend-remote.js';
import { httpTransport } from './runner-agent.js';
import { getJobChannel } from './runner-job-channel.js';
import type { AddressInfo } from 'net';
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

  it('claim AWAITS task protection before returning the job (closes the claim→protect race)', async () => {
    const mockedArm = vi.mocked(armHubTaskProtection);
    let releaseArm!: () => void;
    let armSettled = false;
    // Deferred arm: stays pending until we release it. With the handler awaiting
    // the arm, the claim response can't be sent until then. (A fire-and-forget
    // `void arm()` would send the job immediately → this test would fail.)
    mockedArm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseArm = () => {
            armSettled = true;
            resolve('armed');
          };
        }),
    );
    // Register WITH a task ARN so the claim handler looks it up and arms THIS task.
    const taskArn = 'arn:aws:ecs:us-east-2:1:task/test-fleet/abc123';
    const reg = await request(app)
      .post('/api/runners/register')
      .send({ fleetToken: FLEET, ecsTaskArn: taskArn });
    expect(reg.status).toBe(200);
    const token = reg.body.token as string;
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

    const claimP = request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    let responded = false;
    void claimP.then(() => {
      responded = true;
    });

    // Ample time for the handler to claim + invoke arm. The claim must still be
    // BLOCKED on the (un-released) arm — that's the race being closed.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockedArm).toHaveBeenCalledWith(taskArn, expect.anything(), { force: true });
    expect(responded).toBe(false);

    releaseArm();
    const claim = await claimP;
    expect(claim.status).toBe(200);
    expect(armSettled).toBe(true);
  });

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
      { id: jobId, spotReclaimed: true, ecsTaskArn: null },
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

  // Regression (card #1184): the stall this whole card fixes. An agent claims a
  // job, dies during container bring-up BEFORE its first poll (never attaches),
  // and reports the loss via POST /error (#3a). The backend's acquire() is parked
  // on channel.ready; that report must reject `ready` (#1) so acquire fails FAST
  // (→ infra_error → retry) instead of waiting out acquireTimeoutMs (≈ the whole
  // run budget). acquireTimeoutMs is set deliberately huge here: if the fix
  // regresses, this test hangs to the vitest timeout instead of passing.
  it('agent POST /error before attach makes acquire reject immediately, not after the budget', async () => {
    const token = await register();
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 600_000 });
    const acquireP = backend.acquire(SPEC);
    // Swallow the expected rejection on a second handle so it can't surface as an
    // unhandled rejection while we drive the HTTP calls.
    const settled = acquireP.then(
      () => ({ ok: true as const }),
      (err: Error) => ({ ok: false as const, err }),
    );

    const claim = await request(app)
      .post('/api/runners/claim')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(claim.status).toBe(200);
    const jobId = claim.body.jobId as string;
    expect(getJobChannel(jobId)?.isAttached).toBe(false); // never polled → not attached

    // Agent's runAgentJob threw during bring-up; it reports the loss.
    const errRes = await request(app)
      .post(`/api/runners/jobs/${jobId}/error`)
      .set('Authorization', `Bearer ${token}`)
      .send({ detail: 'inner dockerd not ready within 120s' });
    expect(errRes.status).toBe(204);

    const outcome = await settled;
    expect(outcome.ok).toBe(false);
    expect((outcome as { err: Error }).err.message).toMatch(/lost before attach/);
    expect((outcome as { err: Error }).err.message).toContain('inner dockerd not ready');

    // Queue row is terminal and the channel is cleaned up.
    const row = getOrgsDb()
      .prepare('SELECT state, detail FROM runner_jobs WHERE id=?')
      .get(jobId) as { state: string; detail: string | null };
    expect(row.state).toBe('lost');
    expect(getJobChannel(jobId)).toBeUndefined();
  });

  // Reviewer ask (card #1184): exercise the REAL httpTransport.reportError against
  // the REAL route over real HTTP — not supertest's .send() defaults — so the wire
  // contract is proven end-to-end: the transport's application/json content type
  // must make express.json() populate req.body.detail, otherwise the route silently
  // drops the bring-up detail and falls back to a generic message.
  it('real httpTransport.reportError reaches the route and its detail is parsed (not dropped)', async () => {
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const reg = await request(app).post('/api/runners/register').send({ fleetToken: FLEET });
      expect(reg.status).toBe(200);
      const token = reg.body.token as string;
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

      // The real transport: real fetch, real headers (content type via shared auth).
      await httpTransport(base, token).reportError(jobId, 'inner dockerd not ready within 120s');

      const row = getOrgsDb()
        .prepare('SELECT state, detail FROM runner_jobs WHERE id=?')
        .get(jobId) as { state: string; detail: string | null };
      expect(row.state).toBe('lost');
      // The crux: req.body.detail was parsed (content type honored) → the specific
      // detail is persisted, NOT the 'runner agent reported a job error' fallback.
      expect(row.detail).toBe('inner dockerd not ready within 120s');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
