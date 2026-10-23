import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../types.js';
import type { PreviewConfig } from '../deploy/deploy-preview-config.js';
import type { PrEnvironmentDto, PrEnvironmentReporter } from './pr-environments.js';
import type {
  EnvironmentRunner,
  EnvironmentRunnerStatus,
  EnvironmentStartRequest,
} from './pr-environment-runner.js';
import { createRunnerPrEnvironmentRuntime } from './pr-environment-runner-runtime.js';

const PROJECT = { id: 'p1' } as Project;
const PREVIEW: PreviewConfig = {
  compose: 'docker-compose.preview.yml',
  service: 'app',
  port: 3000,
  health: '/healthz',
  healthTimeoutMinutes: 5,
  steps: [{ name: 'seed', run: 'make seed' }],
  secrets: ['DB_PASSWORD'],
};

function env(over: Partial<PrEnvironmentDto> = {}): PrEnvironmentDto {
  return {
    id: 'env-1',
    projectId: 'p1',
    source: 'native',
    prNumber: 12,
    headSha: 'a'.repeat(40),
    headBranch: 'feat',
    status: 'queued',
    url: null,
    error: null,
    stopReason: null,
    runnerRef: null,
    cleanupPending: false,
    logTail: [],
    createdAt: '',
    updatedAt: '',
    readyAt: null,
    stoppedAt: null,
    lastHitAt: null,
    renewedAt: '',
    ...over,
  };
}

function reporter() {
  return {
    building: vi.fn(),
    ready: vi.fn(),
    failed: vi.fn(),
    lost: vi.fn(),
    log: vi.fn(),
  } satisfies PrEnvironmentReporter;
}

function fakeRunner() {
  const statuses = new Map<string, EnvironmentRunnerStatus>();
  const started: EnvironmentStartRequest[] = [];
  let n = 0;
  let gate: Promise<void> | null = null;
  const runner: EnvironmentRunner & { stop: ReturnType<typeof vi.fn> } = {
    kind: 'remote',
    async start(req) {
      if (gate) await gate;
      started.push(req);
      const ref = `job-${++n}`;
      statuses.set(ref, { state: 'pending', upstream: null, detail: null });
      return ref;
    },
    async status(ref) {
      return statuses.get(ref) ?? { state: 'stopped', upstream: null, detail: null };
    },
    stop: vi.fn(async (ref: string) => {
      statuses.set(ref, { state: 'stopped', upstream: null, detail: null });
    }),
    async readLogs(_ref, cursor) {
      return cursor < 0 ? { lines: ['==> compose up'], cursor: 0 } : { lines: [], cursor };
    },
  };
  return {
    runner,
    started,
    set: (
      ref: string,
      s: Partial<EnvironmentRunnerStatus> & { state: EnvironmentRunnerStatus['state'] },
    ) => statuses.set(ref, { upstream: null, detail: null, ...s }),
    hold: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}

function make(f: ReturnType<typeof fakeRunner>, over: Record<string, unknown> = {}) {
  let t = 1_000;
  const rt = createRunnerPrEnvironmentRuntime({
    runner: f.runner,
    readPreviewConfig: async () => PREVIEW,
    resolveSecrets: () => ({ DB_PASSWORD: 'pw' }),
    orgId: () => 'org-1',
    startTimer: () => ({ stop: () => {} }),
    now: () => t,
    ...over,
  });
  return { rt, advance: (ms: number) => (t += ms) };
}

describe('runner PR environment runtime', () => {
  it('starts the compose stack and reports building, logs, then the ready upstream', async () => {
    const f = fakeRunner();
    const { rt } = make(f);
    const r = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r });
    expect(f.started[0]).toMatchObject({
      orgId: 'org-1',
      prNumber: 12,
      env: { DB_PASSWORD: 'pw' },
      spec: {
        composeProject: 'pr-12',
        composeFile: 'docker-compose.preview.yml',
        service: 'app',
        port: 3000,
        health: '/healthz',
        steps: [{ name: 'seed', run: 'make seed' }],
      },
    });
    expect(r.building).toHaveBeenCalledWith('job-1');
    await rt.tick();
    expect(r.log).toHaveBeenCalledWith(['==> compose up']);
    f.set('job-1', { state: 'ready', upstream: { host: '10.0.0.7', port: 32771 } });
    await rt.tick();
    await rt.tick();
    expect(r.ready).toHaveBeenCalledTimes(1);
    expect(r.ready).toHaveBeenCalledWith('http://10.0.0.7:32771');
    expect(rt.upstreamFor('job-1')).toEqual({ host: '10.0.0.7', port: 32771 });
  });

  it('fails without starting anything when secrets cannot be resolved', async () => {
    const f = fakeRunner();
    const { rt } = make(f, {
      resolveSecrets: () => {
        throw new Error('preview: secret "DB_PASSWORD" not found');
      },
    });
    const r = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r });
    expect(r.failed).toHaveBeenCalledWith('preview: secret "DB_PASSWORD" not found');
    expect(f.started).toHaveLength(0);
  });

  it('reports a runner loss with requeue, and stops requeuing after the budget', async () => {
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 1 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r1.lost).toHaveBeenCalledWith(expect.stringContaining('lease expired'), {
      requeue: true,
    });
    expect(rt.watched()).toEqual([]);

    // The requeued build is lost too: budget spent, fail instead.
    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    f.set('job-2', { state: 'lost', detail: 'spot reclaim' });
    await rt.tick();
    expect(r2.lost).toHaveBeenCalledWith(expect.any(String), { requeue: false });
  });

  it('keeps counting losses of environments that die soon after ready', async () => {
    // Regression: every rebuild reached ready, which reset the count, so an
    // environment whose runner died ~15 minutes after each boot rebuilt 113
    // times instead of stopping at the cap.
    const f = fakeRunner();
    const { rt, advance } = make(f, { maxLossRequeues: 1, stableReadyMs: 60 * 60_000 });
    const expected = [true, false];
    for (const [i, ref] of ['job-1', 'job-2'].entries()) {
      const r = reporter();
      await rt.build({ project: PROJECT, env: env(), reporter: r });
      f.set(ref, { state: 'ready', upstream: { host: 'h', port: 1 } });
      await rt.tick();
      advance(15 * 60_000);
      f.set(ref, { state: 'lost', detail: 'lease expired' });
      await rt.tick();
      expect(r.lost).toHaveBeenCalledWith(expect.any(String), { requeue: expected[i] });
    }
  });

  it('a loss after a long ready period starts a new count', async () => {
    const f = fakeRunner();
    const { rt, advance } = make(f, { maxLossRequeues: 1, stableReadyMs: 60 * 60_000 });
    for (const ref of ['job-1', 'job-2', 'job-3']) {
      const r = reporter();
      await rt.build({ project: PROJECT, env: env(), reporter: r });
      f.set(ref, { state: 'ready', upstream: { host: 'h', port: 1 } });
      await rt.tick();
      advance(61 * 60_000);
      f.set(ref, { state: 'lost', detail: 'spot reclaim' });
      await rt.tick();
      expect(r.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
    }
  });

  it('keeps the count across the teardown that is part of a requeue', async () => {
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 1 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r1.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
    // The service tears the lost stack down before it rebuilds.
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });

    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    f.set('job-2', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r2.lost).toHaveBeenCalledWith(expect.stringContaining('2 times in a row'), {
      requeue: false,
    });
  });

  it('a stop ends the run of losses, so the next build starts counting from zero', async () => {
    // Regression: a loss before the environment was stopped overnight still
    // counted the next day, so two losses in the new build read as "3 times
    // in a row" and the second one was not rebuilt.
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 1 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });
    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    // Stopped by the user (or idle) while running.
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-2' }) });

    const r3 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r3 });
    f.set('job-3', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r3.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
  });

  it('a stop between the rebuild cleanup and the rebuild resets the count', async () => {
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 1 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r1.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
    // Rebuild cleanup, then a stop before the rebuild was dispatched.
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });
    await rt.teardown({ project: PROJECT, env: env() });

    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    f.set('job-2', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r2.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
  });

  it('a failed rebuild cleanup keeps the count through its retry', async () => {
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 1 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    f.runner.stop.mockRejectedValueOnce(new Error('docker hiccup'));
    await expect(
      rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) }),
    ).rejects.toThrow('docker hiccup');
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });

    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    f.set('job-2', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r2.lost).toHaveBeenCalledWith(expect.any(String), { requeue: false });
  });

  it('Retry after the cap starts a fresh count', async () => {
    const f = fakeRunner();
    const { rt } = make(f, { maxLossRequeues: 0 });
    const r1 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r1 });
    f.set('job-1', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r1.lost).toHaveBeenCalledWith(
      'The runner hosting this environment was lost (lease expired). Retry to rebuild.',
      {
        requeue: false,
      },
    );
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });

    const r2 = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r2 });
    f.set('job-2', { state: 'lost', detail: 'lease expired' });
    await rt.tick();
    expect(r2.lost).toHaveBeenCalledWith(
      'The runner hosting this environment was lost (lease expired). Retry to rebuild.',
      {
        requeue: false,
      },
    );
  });

  it('teardown is idempotent and stops a start that resolves after it', async () => {
    const f = fakeRunner();
    const { rt } = make(f);
    const r = reporter();
    const release = f.hold();
    const building = rt.build({ project: PROJECT, env: env(), reporter: r });
    await rt.teardown({ project: PROJECT, env: env() });
    release();
    await building;
    expect(r.building).not.toHaveBeenCalled();
    expect(f.runner.stop).toHaveBeenCalledWith('job-1');

    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });
    await rt.teardown({ project: PROJECT, env: env({ runnerRef: 'job-1' }) });
    expect(rt.watched()).toEqual([]);
  });

  it('fails a build no runner picks up within the queue timeout', async () => {
    const f = fakeRunner();
    const { rt, advance } = make(f, { queueTimeoutMs: 60_000 });
    const r = reporter();
    await rt.build({ project: PROJECT, env: env(), reporter: r });
    advance(61_000);
    await rt.tick();
    expect(f.runner.stop).toHaveBeenCalledWith('job-1');
    expect(r.failed).toHaveBeenCalledWith(expect.stringMatching(/No runner picked up/));
  });

  it('reattach adopts a live environment after a restart and reports loss of a dead one', async () => {
    const f = fakeRunner();
    const { rt } = make(f);
    f.set('job-9', { state: 'ready', upstream: { host: '10.0.0.9', port: 32000 } });
    const r = reporter();
    expect(
      await rt.reattach!({
        project: PROJECT,
        env: env({ status: 'ready', runnerRef: 'job-9' }),
        reporter: r,
      }),
    ).toBe(true);
    expect(rt.watched()).toEqual(['job-9']);
    expect(r.ready).toHaveBeenCalledWith('http://10.0.0.9:32000');

    f.set('job-8', { state: 'lost', detail: 'the environment container is gone' });
    const r2 = reporter();
    expect(
      await rt.reattach!({
        project: PROJECT,
        env: env({ id: 'env-2', status: 'ready', runnerRef: 'job-8' }),
        reporter: r2,
      }),
    ).toBe(true);
    expect(r2.lost).toHaveBeenCalledWith(expect.stringContaining('container is gone'), {
      requeue: true,
    });

    expect(
      await rt.reattach!({
        project: PROJECT,
        env: env({ runnerRef: 'job-unknown' }),
        reporter: reporter(),
      }),
    ).toBe(false);
    expect(await rt.reattach!({ project: PROJECT, env: env(), reporter: reporter() })).toBe(false);
  });
});
