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

  it('nextDirective long-polls: null after timeout, resolves when a directive is pushed', async () => {
    const ch = createJobChannel('job2');
    expect(await ch.nextDirective(20)).toBeNull();

    const pending = ch.nextDirective(1000);
    ch.finish();
    expect(await pending).toEqual({ type: 'finish' });

    removeJobChannel('job2');
  });
});
