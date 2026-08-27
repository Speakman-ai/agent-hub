import { describe, expect, it } from 'vitest';
import { RemoteSpawnedStep } from './remote-spawned-step.js';
import { createJobChannel, removeJobChannel } from './runner-job-channel.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('RemoteSpawnedStep', () => {
  it('feeds stdout/stderr and fires close exactly once with the exit code', async () => {
    const cancels: number[] = [];
    const step = new RemoteSpawnedStep(2, { cancelStep: (i) => cancels.push(i) });
    let out = '';
    let err = '';
    step.stdout.on('data', (d) => (out += d.toString()));
    step.stderr.on('data', (d) => (err += d.toString()));
    const closes: Array<number | null> = [];
    step.on('close', (c) => closes.push(c));

    step.feed('stdout', 'hello');
    step.feed('stdout', ' world');
    step.feed('stderr', 'warn');
    step.exit(0);
    step.exit(0); // second is ignored
    step.feed('stdout', 'after-close'); // ignored
    await tick();

    expect(out).toBe('hello world');
    expect(err).toBe('warn');
    expect(closes).toEqual([0]); // exactly one close
  });

  it('kill() asks the sink to cancel the step', () => {
    const cancels: number[] = [];
    const step = new RemoteSpawnedStep(5, { cancelStep: (i) => cancels.push(i) });
    expect(step.kill('SIGTERM')).toBe(true);
    expect(cancels).toEqual([5]);
  });

  it('fail() surfaces an error (or a synthetic close so step-runner never hangs)', async () => {
    const withErr = new RemoteSpawnedStep(0, { cancelStep: () => {} });
    const errs: Error[] = [];
    withErr.on('error', (e) => errs.push(e));
    withErr.fail(new Error('dropped'));
    await tick();
    expect(errs.map((e) => e.message)).toEqual(['dropped']);

    const noErrHandler = new RemoteSpawnedStep(0, { cancelStep: () => {} });
    const closes: Array<number | null> = [];
    noErrHandler.on('close', (c) => closes.push(c));
    noErrHandler.fail(new Error('dropped'));
    await tick();
    expect(closes).toEqual([null]); // synthetic close, no hang
  });
});

describe('RunnerJobChannel', () => {
  it('runStep queues a directive; agent logs/result drive the SpawnedStep', async () => {
    const ch = createJobChannel('job1');
    let ready = false;
    void ch.ready.then(() => (ready = true));

    const step = ch.runStep(0, 'echo hi', { FOO: 'bar' });
    let out = '';
    step.stdout.on('data', (d) => (out += d.toString()));
    const closes: Array<number | null> = [];
    step.on('close', (c) => closes.push(c));

    // agent's first poll picks up the directive AND attaches (ready resolves)
    const d = await ch.nextDirective(1000);
    expect(d).toEqual({ type: 'run_step', stepIndex: 0, run: 'echo hi', env: { FOO: 'bar' } });
    // No deadline passed → directive omits it (agent applies its own ceiling).
    expect((d as { deadlineMs?: number }).deadlineMs).toBeUndefined();
    await ch.ready;
    expect(ready).toBe(true);
    expect(ch.isAttached).toBe(true);

    ch.onLog(0, 'stdout', 'hi\n');
    ch.onStepResult(0, 0);
    await tick();
    expect(out).toBe('hi\n');
    expect(closes).toEqual([0]);

    removeJobChannel('job1');
  });

  it('runStep forwards a positive deadlineMs into the run_step directive', async () => {
    const ch = createJobChannel('job1d');
    ch.runStep(2, 'npm test', { A: '1' }, 30_000);
    expect(await ch.nextDirective(1000)).toEqual({
      type: 'run_step',
      stepIndex: 2,
      run: 'npm test',
      env: { A: '1' },
      deadlineMs: 30_000,
    });
    // A non-positive / undefined deadline is omitted, never sent as 0.
    ch.runStep(3, 'npm run lint', {}, 0);
    expect(await ch.nextDirective(1000)).toEqual({
      type: 'run_step',
      stepIndex: 3,
      run: 'npm run lint',
      env: {},
    });
    removeJobChannel('job1d');
  });

  it('nextDirective long-polls: null after timeout, resolves when a directive is pushed', async () => {
    const ch = createJobChannel('job2');
    expect(await ch.nextDirective(20)).toBeNull();

    const pending = ch.nextDirective(1000);
    ch.finish();
    expect(await pending).toEqual({ type: 'finish' });

    removeJobChannel('job2');
  });

  // Regression (card #1184): an agent that claimed a job then died during
  // container bring-up — BEFORE its first directive poll — never attaches. The
  // lease reaper / agent error report calls fail(); that MUST settle `ready` by
  // rejecting it, otherwise the backend's acquire-phase `Promise.race` on
  // channel.ready hangs until its timeout (≈ the whole run budget), stranding the
  // Finalize run even though the queue row is already `lost`.
  it('fail() before attach rejects ready so the acquire wait unblocks immediately', async () => {
    const ch = createJobChannel('job-preattach');
    expect(ch.isAttached).toBe(false);

    let rejected: Error | null = null;
    const waiter = ch.ready.catch((e: Error) => {
      rejected = e;
    });

    ch.fail(new Error('runner agent lost — inner dockerd not ready'));
    await waiter;

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as unknown as Error).message).toContain('inner dockerd not ready');
    // Never falsely reports an attach just because it failed.
    expect(ch.isAttached).toBe(false);

    removeJobChannel('job-preattach');
  });

  it('fail() after a real attach leaves ready resolved (no late rejection)', async () => {
    const ch = createJobChannel('job-attached');
    // First poll attaches → ready resolves.
    await ch.nextDirective(5);
    expect(ch.isAttached).toBe(true);
    await expect(ch.ready).resolves.toBeUndefined();

    // A subsequent fail() must NOT turn the already-resolved ready into a
    // rejection (which would surface as an unhandled rejection). It still fails
    // in-flight steps via the existing path.
    const step = ch.runStep(0, 'sleep 1', {});
    const closes: Array<number | null> = [];
    step.on('close', (c) => closes.push(c));
    ch.fail(new Error('transport dropped mid-run'));
    await tick();
    await expect(ch.ready).resolves.toBeUndefined();
    expect(closes).toEqual([null]); // step force-closed, step-runner unblocks

    removeJobChannel('job-attached');
  });

  it('fail() with no awaiter on ready does not raise an unhandled rejection', async () => {
    const ch = createJobChannel('job-noawaiter');
    // Nobody awaits ch.ready. fail() rejects it internally — the constructor's
    // no-op catch must absorb it so the process never sees an unhandledRejection.
    ch.fail(new Error('lost before anyone awaited'));
    await tick();
    await tick();
    // If this test completes without the vitest unhandled-rejection guard firing,
    // the absorb worked.
    expect(ch.isAttached).toBe(false);
    removeJobChannel('job-noawaiter');
  });

  // Stop Finalize path: the cancel directive must be EMITTED for in-flight steps.
  // Regression: on run-cancel the emission cannot rely on the step-runner's own
  // kill→cancelStep (fail() settles the step first and that path short-circuits
  // on `settled`), so the channel emits it directly, before fail().
  it('cancelInFlightSteps emits a cancel directive for each in-flight step', async () => {
    const ch = createJobChannel('job-cancel');
    await ch.nextDirective(5); // attach
    ch.runStep(0, 'npm test', {});
    ch.runStep(1, 'npm run lint', {});
    // Drain the two run_step directives so the outbound queue is empty.
    expect(await ch.nextDirective(50)).toMatchObject({ type: 'run_step', stepIndex: 0 });
    expect(await ch.nextDirective(50)).toMatchObject({ type: 'run_step', stepIndex: 1 });

    const emitted = ch.cancelInFlightSteps('SIGTERM');
    expect(emitted.sort()).toEqual([0, 1]);
    // The buffered cancel directives are delivered on the next polls.
    expect(await ch.nextDirective(50)).toEqual({ type: 'cancel', stepIndex: 0, signal: 'SIGTERM' });
    expect(await ch.nextDirective(50)).toEqual({ type: 'cancel', stepIndex: 1, signal: 'SIGTERM' });

    removeJobChannel('job-cancel');
  });

  it('cancelInFlightSteps emits BEFORE fail() settles the step (ordering)', async () => {
    const ch = createJobChannel('job-cancel-order');
    await ch.nextDirective(5); // attach
    const step = ch.runStep(0, 'npm test', {});
    expect(await ch.nextDirective(50)).toMatchObject({ type: 'run_step', stepIndex: 0 });

    // Agent is polling for its next directive when Stop lands.
    const pollP = ch.nextDirective(1000);
    const errors: Error[] = [];
    step.on('error', (e) => errors.push(e));

    // Mirror cancelRemoteJobsForRun's order: emit the directive, THEN fail.
    ch.cancelInFlightSteps('SIGTERM');
    ch.fail(new Error('finalize run cancelled by user'));
    await tick();

    // The pending poll got the cancel directive (not swallowed by fail()).
    expect(await pollP).toEqual({ type: 'cancel', stepIndex: 0, signal: 'SIGTERM' });
    // fail() still settled the in-flight step so the step-runner unblocks.
    expect(errors).toHaveLength(1);

    removeJobChannel('job-cancel-order');
  });
});
