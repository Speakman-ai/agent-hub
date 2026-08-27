import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { claimRunnerJob, probeRunnerJobLoss, reportRunnerJob } from './runner-queue.js';
import { getJobChannel } from './runner-job-channel.js';
import {
  cancelRemoteJobsForRun,
  createRemoteRunnerBackend,
  __test,
} from './runner-backend-remote.js';
import type { BundleStore } from './worktree-bundle.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('createRemoteRunnerBackend', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'remote-backend-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });
  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('enqueues, waits for an agent to claim+attach, then streams steps and tears down', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 2000 });

    // Kick off acquire (enqueue + create channel happen synchronously before the
    // first await, so the job is claimable on the next line).
    const acquireP = backend.acquire({
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
    });

    // Simulate the pull-based agent: claim the job, then attach (claim-time
    // handshake — production does this in POST /claim before bring-up).
    const claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
    expect(claimed).not.toBeNull();
    const channel = getJobChannel(claimed!.id)!;
    expect(channel).toBeDefined();
    channel.attach();
    const lease = await acquireP;
    const pollP = channel.nextDirective(1000);

    // Backend pushes a step; the agent's poll receives the run_step directive.
    const step = lease.spawnStep({
      step: { name: 's', run: 'echo hi' },
      index: 0,
      cwd: '/tmp/wt',
      env: { FOO: 'bar' },
    });
    expect(await pollP).toEqual({
      type: 'run_step',
      stepIndex: 0,
      run: 'echo hi',
      env: { FOO: 'bar' },
    });

    // Agent streams output and reports the exit code.
    let out = '';
    step.stdout!.on('data', (d) => (out += d.toString()));
    const closes: Array<number | null> = [];
    step.on('close', (c) => closes.push(c));
    channel.onLog(0, 'stdout', 'hi\n');
    channel.onStepResult(0, 0);
    await tick();
    expect(out).toBe('hi\n');
    expect(closes).toEqual([0]);

    // Release: agent gets a finish directive, channel is disposed.
    const finishP = channel.nextDirective(1000);
    await lease.release();
    expect(await finishP).toEqual({ type: 'finish' });
    expect(getJobChannel(claimed!.id)).toBeUndefined();
  });

  // Stop Finalize: cancelRemoteJobsForRun must flip the queue row terminal,
  // settle the in-flight step in THIS process (so runStepsSequence unblocks and
  // the orchestrator reaches cancelTerminal), and dispose the channel so the
  // agent's next poll is `410 gone`.
  it('cancelRemoteJobsForRun cancels the queue row, fails the in-flight step, and disposes the channel', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 2000 });
    const acquireP = backend.acquire({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'run-cancel',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      worktreePath: '/tmp/wt',
      composeProjectName: 'cp',
      env: {},
      labels: {},
    });
    const claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
    const channel = getJobChannel(claimed!.id)!;
    channel.attach();
    const lease = await acquireP;

    // A step is in flight (agent running its docker exec).
    const step = lease.spawnStep({
      step: { name: 's', run: 'npm test' },
      index: 0,
      cwd: '/tmp/wt',
      env: {},
    });
    // Drain the run_step directive the agent would have received on spawn, so the
    // next poll is waiting for a fresh directive (models the agent polling again).
    expect(await channel.nextDirective(1000)).toMatchObject({ type: 'run_step', stepIndex: 0 });
    const cancelPollP = channel.nextDirective(1000);

    const errors: Error[] = [];
    step.on('error', (e) => errors.push(e));

    // User presses Stop → the run's remote jobs are cancelled.
    const n = cancelRemoteJobsForRun('run-cancel', Date.now());
    await tick();

    expect(n).toBe(1);
    // The cancel directive is EMITTED before the channel is failed/disposed — the
    // pending agent poll receives it (regression: fail() used to settle the step
    // first, short-circuiting the step-runner's own cancel emission).
    expect(await cancelPollP).toEqual({ type: 'cancel', stepIndex: 0, signal: 'SIGTERM' });
    // Queue row is terminal-cancelled (a later report is a no-op).
    expect(probeRunnerJobLoss(claimed!.id, Date.now())?.state).toBe('cancelled');
    // In-flight step settled in-process so the step-runner unblocks immediately.
    expect(errors).toHaveLength(1);
    // Channel disposed → the agent's next poll returns 410 gone and it tears down.
    expect(getJobChannel(claimed!.id)).toBeUndefined();
  });

  it('cancelRemoteJobsForRun returns 0 and no-ops when the run has no live jobs', () => {
    expect(cancelRemoteJobsForRun('nonexistent-run', Date.now())).toBe(0);
  });

  // Loss-evidence seam: every remote step must carry a probe wired to its queue
  // row so step-runner can tell "genuine overrun on a live runner" (timeout,
  // parked) from "the runner died underneath the step" (infra, retried) when a
  // hard timeout fires without a terminal event.
  it('wires probeRunnerLoss on every spawned step to the job queue row', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 2000 });
    const acquireP = backend.acquire({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      worktreePath: '/tmp/wt',
      composeProjectName: 'cp',
      env: {},
      labels: {},
    });
    const claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
    const channel = getJobChannel(claimed!.id)!;
    channel.attach(); // claim-time attach → unblocks acquire
    const lease = await acquireP;

    const step = lease.spawnStep({
      step: { name: 's', run: 'echo hi' },
      index: 0,
      cwd: '/tmp/wt',
      env: {},
    });
    // Lease alive: no loss signal, but real evidence flows from the queue row.
    expect(step.probeRunnerLoss).toBeTypeOf('function');
    expect(step.probeRunnerLoss!()).toMatchObject({
      state: 'claimed',
      lost: false,
      leaseExpired: false,
      spotInterrupted: false,
    });
    // Reaper marks the job lost → the same probe now reports the loss.
    reportRunnerJob({
      jobId: claimed!.id,
      state: 'lost',
      detail: 'lease expired',
      now: Date.now(),
    });
    expect(step.probeRunnerLoss!()).toMatchObject({ state: 'lost', lost: true });
  });

  // The production seam: step-runner computes the per-step deadline and hands it
  // to spawnStep, which must forward it into the run_step directive so the agent
  // enforces it locally. Without this the deadline silently never reaches the
  // remote runner and a hung step hangs forever.
  it('forwards SpawnStepArgs.deadlineMs into the run_step directive', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 2000 });
    const acquireP = backend.acquire({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r-deadline',
      jobId: 'e2e',
      matrixKey: '',
      image: 'img:latest',
      worktreePath: '/tmp/wt',
      composeProjectName: 'cp',
      env: {},
      labels: {},
    });
    const claimed = claimRunnerJob({ agentId: 'agent-d', leaseMs: 60_000, now: Date.now() });
    const channel = getJobChannel(claimed!.id)!;
    channel.attach();
    const lease = await acquireP;
    const pollP = channel.nextDirective(1000);

    lease.spawnStep({
      step: { name: 's', run: 'npm test' },
      index: 2,
      cwd: '/tmp/wt',
      env: {},
      deadlineMs: 90_000,
    });
    expect(await pollP).toEqual({
      type: 'run_step',
      stepIndex: 2,
      run: 'npm test',
      env: {},
      deadlineMs: 90_000,
    });

    await lease.release();
  });

  it('forwards minimalEnv onto the wire spec so the agent isolates deploy env', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 2000 });
    const acquireP = backend.acquire({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'deploy-1',
      jobId: 'prod',
      matrixKey: 'deploy',
      image: 'img:latest',
      worktreePath: '/tmp/wt',
      composeProjectName: 'cp',
      env: { PATH: '/usr/bin' },
      labels: {},
      minimalEnv: true,
    });

    const claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
    expect(claimed).not.toBeNull();
    const wireSpec = JSON.parse(claimed!.specJson) as { minimalEnv?: boolean; env: unknown };
    expect(wireSpec.minimalEnv).toBe(true);
    expect(wireSpec.env).toEqual({ PATH: '/usr/bin' });

    // Complete the handshake so the acquire promise settles (no dangling timer).
    const channel = getJobChannel(claimed!.id)!;
    channel.attach();
    const lease = await acquireP;
    await lease.release();
  });

  it('rebundles when a fix-round advances HEAD, but shares one bundle within a round', async () => {
    // Regression for the stale-code livelock: the bundle was memoized by runId
    // alone, so across fix-dispatch rounds (stable runId) the fleet re-tested the
    // first round's code forever while FINALIZE_HEAD_SHA + the reviewer advanced.
    const calls: Array<{ key: string; rev?: string }> = [];
    const fakeCreate = (async (args: { key: string; rev?: string }) => {
      calls.push({ key: args.key, rev: args.rev });
      return { key: args.key, sha256: 'deadbeef', sizeBytes: 1 };
    }) as any;
    const store: BundleStore = {
      put: async () => {},
      get: async () => {},
      presignGet: async (key: string) => `https://example.test/${key}`,
    };
    const backend = createRemoteRunnerBackend({
      acquireTimeoutMs: 2000,
      store,
      createBundle: fakeCreate,
    });

    const runAcquire = async (env: Record<string, string>) => {
      const acquireP = backend.acquire({
        orgId: 'orgA',
        projectId: 'p1',
        runId: 'r1', // same run across all rounds (the livelock precondition)
        jobId: 'e2e',
        matrixKey: '',
        image: 'img:latest',
        worktreePath: '/tmp/wt',
        composeProjectName: 'cp',
        env,
        labels: {},
      });
      // With a store, acquire awaits the bundle before enqueuing — poll until the
      // job is claimable rather than claiming synchronously.
      let claimed: { id: string } | null = null;
      for (let i = 0; i < 100 && !claimed; i++) {
        claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
        if (!claimed) await tick();
      }
      expect(claimed).not.toBeNull();
      const channel = getJobChannel(claimed!.id)!;
      channel.attach();
      const pollP = channel.nextDirective(1000);
      const lease = await acquireP;
      await pollP;
      await lease.release();
    };

    // Round 1: two matrix shards at the same HEAD share a single bundle.
    await runAcquire({ FINALIZE_HEAD_SHA: 'sha-aaaaaa' });
    await runAcquire({ FINALIZE_HEAD_SHA: 'sha-aaaaaa' });
    expect(calls).toHaveLength(1);

    // Round 2: a fix advanced HEAD → the cached bundle is busted, fresh build.
    await runAcquire({ FINALIZE_HEAD_SHA: 'sha-bbbbbb' });
    expect(calls).toHaveLength(2);

    // Each bundle is pinned to its own commit and written under a distinct key.
    expect(calls[0].rev).toBe('sha-aaaaaa');
    expect(calls[1].rev).toBe('sha-bbbbbb');
    expect(calls[0].key).not.toBe(calls[1].key);
  });

  it('throws (→ infra_error) when no agent claims within the timeout', async () => {
    const backend = createRemoteRunnerBackend({ acquireTimeoutMs: 60 });
    await expect(
      backend.acquire({
        orgId: 'orgA',
        projectId: 'p1',
        runId: 'r1',
        jobId: 'e2e',
        matrixKey: '',
        image: 'img',
        worktreePath: '/tmp/wt',
        composeProjectName: 'cp',
        env: {},
        labels: {},
      }),
    ).rejects.toThrow(/no runner-agent claimed/);
  });

  it('caps the backend acquire timeout to the per-job remaining budget', () => {
    expect(__test.DEFAULT_ACQUIRE_TIMEOUT_MS).toBe(60 * 60_000);
    expect(__test.effectiveAcquireTimeoutMs(60_000, undefined)).toBe(60_000);
    expect(__test.effectiveAcquireTimeoutMs(60_000, 2_500)).toBe(2_500);
    expect(__test.effectiveAcquireTimeoutMs(60_000, 90_000)).toBe(60_000);
    expect(__test.effectiveAcquireTimeoutMs(60_000, -1)).toBe(60_000);
  });
});
