import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import { claimRunnerJob } from './runner-queue.js';
import { getJobChannel } from './runner-job-channel.js';
import { createRemoteRunnerBackend } from './runner-backend-remote.js';

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

    // Simulate the pull-based agent: claim the job, then poll (which attaches
    // the channel → unblocks acquire).
    const claimed = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: Date.now() });
    expect(claimed).not.toBeNull();
    const channel = getJobChannel(claimed!.id)!;
    expect(channel).toBeDefined();

    const pollP = channel.nextDirective(1000); // first poll attaches
    const lease = await acquireP;

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
});
