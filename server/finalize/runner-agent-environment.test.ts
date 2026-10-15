import { describe, expect, it, vi } from 'vitest';
import {
  SPOT_RECLAIMED_DURING_BRINGUP,
  createEnvironmentExec,
  resolveAdvertiseHost,
  runAgentEnvironment,
  type EnvironmentDocker,
  type EnvironmentReport,
  type EnvironmentTransport,
} from './runner-agent-environment.js';
import { ENVIRONMENT_GATEWAY_PORT } from './runner-environment.js';
import type { RunnerJobWireSpec } from './runner-backend-remote.js';

const SPEC: RunnerJobWireSpec = {
  orgId: 'o',
  projectId: 'p',
  runId: 'prenv-env1-abc',
  jobId: 'pr-7',
  matrixKey: 'environment',
  image: 'runner:img',
  composeProjectName: 'pr-7',
  env: { SECRET: 'v' },
  kind: 'environment',
  environment: {
    composeProject: 'pr-7',
    composeFile: 'compose.yml',
    service: 'web',
    port: 8000,
    health: '/',
    steps: [],
  },
};

function harness(opts: { healthy?: boolean; onExec?: (run: string) => number | undefined } = {}) {
  const reports: EnvironmentReport[] = [];
  let stopRequested = false;
  let hubDown = false;
  let containerRunning: boolean | null = true;
  const heartbeats: string[] = [];
  const spotFlags: boolean[] = [];
  const transport: EnvironmentTransport = {
    postLogs: vi.fn(async () => {}),
    postFinish: vi.fn(async () => {}),
    async heartbeat(_jobId, spotInterruption) {
      spotFlags.push(spotInterruption === true);
      if (hubDown) {
        heartbeats.push('error');
        throw new Error('ECONNREFUSED');
      }
      heartbeats.push(stopRequested ? 'gone' : 'ok');
      return { gone: stopRequested };
    },
    async postEnvironment(_id, report) {
      if (hubDown) throw new Error('ECONNREFUSED');
      reports.push(report);
      return { gone: false };
    },
  };
  const execs: string[] = [];
  const docker: EnvironmentDocker = {
    startContainer: vi.fn(async () => {}),
    async execStep(_name, run, _env, onLog) {
      execs.push(run);
      const forced = opts.onExec?.(run);
      if (forced !== undefined) return forced;
      if (run.startsWith('curl')) onLog('stdout', opts.healthy === false ? '000' : '200');
      return 0;
    },
    hostPort: vi.fn(async () => 32801),
    isRunning: async () => containerRunning,
    stopContainer: vi.fn(async () => {}),
  };
  return {
    transport,
    docker,
    reports,
    execs,
    heartbeats,
    spotFlags,
    stop: () => {
      stopRequested = true;
    },
    setHubDown: (v: boolean) => {
      hubDown = v;
    },
    setContainerRunning: (v: boolean | null) => {
      containerRunning = v;
    },
  };
}

const run = (h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) =>
  runAgentEnvironment({
    jobId: 'job-1',
    spec: SPEC,
    workspaceDir: '/ws',
    transport: h.transport,
    docker: h.docker,
    clearJobWorktreeDest: async () => {},
    resolveHost: async () => '10.0.3.4',
    heartbeatMs: 5,
    logFlushMs: 5,
    delivery: { attempts: 1, baseDelayMs: 0 },
    sleep: async () => {},
    livenessMs: 5,
    readyRetryMs: 5,
    containerCheckRetryMs: 1,
    checkSpot: async () => false,
    spotProbeMs: 5,
    ...extra,
  });

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

describe('runAgentEnvironment', () => {
  it('reports the reachable upstream and holds the stack through a Hub outage until stopped', async () => {
    const h = harness();
    const done = run(h);
    await waitFor(() => h.reports.length > 0);
    expect(h.reports[0]).toEqual({ status: 'ready', host: '10.0.3.4', port: 32801 });
    expect(h.docker.hostPort).toHaveBeenCalledWith(
      'prenv-prenv-env1-abc',
      ENVIRONMENT_GATEWAY_PORT,
    );

    // Hub restarts: heartbeats fail, the environment stays up.
    h.setHubDown(true);
    await waitFor(() => h.heartbeats.filter((x) => x === 'error').length >= 3);
    expect(h.docker.stopContainer).not.toHaveBeenCalled();

    // Hub is back and stops it: teardown, container removed, finish posted.
    h.setHubDown(false);
    h.stop();
    await expect(done).resolves.toEqual({ ready: true, error: null });
    expect(h.execs.some((r) => r.startsWith('docker compose down -v'))).toBe(true);
    expect(h.docker.stopContainer).toHaveBeenCalledWith('prenv-prenv-env1-abc');
    expect(h.transport.postFinish).toHaveBeenCalledWith('job-1', 0, null);
  });

  it('keeps a healthy stack up while the Hub is down for the ready report, then reports it', async () => {
    const h = harness();
    h.setHubDown(true);
    const done = run(h);
    // Well past the bounded critical-delivery attempts (1 in this harness).
    await waitFor(() => h.heartbeats.filter((x) => x === 'error').length >= 5);
    expect(h.reports).toEqual([]);
    expect(h.docker.stopContainer).not.toHaveBeenCalled();
    h.setHubDown(false);
    await waitFor(() => h.reports.length > 0);
    expect(h.reports[0]).toEqual({ status: 'ready', host: '10.0.3.4', port: 32801 });
    expect(h.docker.stopContainer).not.toHaveBeenCalled();
    h.stop();
    await expect(done).resolves.toEqual({ ready: true, error: null });
  });

  it('reports the environment lost when its container dies while heartbeats still succeed', async () => {
    const h = harness();
    const done = run(h);
    await waitFor(() => h.reports.length > 0);
    h.setContainerRunning(false);
    await expect(done).resolves.toEqual({
      ready: false,
      error: 'the environment container stopped',
    });
    expect(h.reports[1]).toEqual({ status: 'lost', detail: 'the environment container stopped' });
    expect(h.heartbeats.every((x) => x === 'ok')).toBe(true);
    expect(h.transport.postFinish).toHaveBeenCalledWith('job-1', 1, null);
  });

  it('one failed container check is not a loss', async () => {
    const h = harness();
    let calls = 0;
    h.docker.isRunning = async () => (++calls === 2 ? null : true);
    const done = run(h);
    await waitFor(() => calls >= 4);
    h.stop();
    await expect(done).resolves.toEqual({ ready: true, error: null });
    expect(h.reports.map((r) => r.status)).toEqual(['ready']);
  });

  it('reports a container that died during compose up as lost, not failed', async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      onExec: (run) => {
        if (!run.startsWith('docker compose up')) return undefined;
        h.setContainerRunning(false); // DinD container killed mid-phase
        return 137;
      },
    });
    const res = await run(h);
    expect(res).toEqual({
      ready: false,
      error: 'the environment container stopped during bring-up',
    });
    expect(h.reports).toEqual([
      { status: 'lost', detail: 'the environment container stopped during bring-up' },
    ]);
  });

  it('reports compose canceled by a Spot reclaim as lost while the container still reads running', async () => {
    // The reclaim SIGTERMs the DinD container; compose prints "context canceled"
    // and exits 1 before docker shows the container as stopped.
    const h = harness({ onExec: (run) => (run.startsWith('docker compose up') ? 1 : undefined) });
    const res = await run(h, { checkSpot: async () => true, spotProbeMs: 60_000 });
    expect(res).toEqual({ ready: false, error: SPOT_RECLAIMED_DURING_BRINGUP });
    expect(h.reports).toEqual([{ status: 'lost', detail: SPOT_RECLAIMED_DURING_BRINGUP }]);
    expect(SPOT_RECLAIMED_DURING_BRINGUP).toContain('[spot_reclaimed]');
    expect(h.spotFlags).toContain(true);
  });

  it('flags a Spot notice on heartbeats during bring-up and stops when the Hub requeues', async () => {
    let spot = false;
    let h!: ReturnType<typeof harness>;
    h = harness({
      onExec: (run) => {
        if (run.startsWith('curl')) {
          spot = true;
          if (h.spotFlags.includes(true)) h.stop(); // Hub requeued on the first flagged beat
          return 0; // no 2xx yet: keeps polling health
        }
        return undefined;
      },
    });
    const res = await run(h, {
      checkSpot: async () => spot,
      sleep: () => new Promise((r) => setTimeout(r, 2)),
    });
    expect(res).toEqual({ ready: false, error: 'stopped' });
    expect(h.spotFlags).toContain(true);
    expect(h.reports).toEqual([]);
    expect(h.docker.stopContainer).toHaveBeenCalled();
  });

  it('keeps a bring-up failure as failed when docker cannot say whether the container is up', async () => {
    const h = harness({ onExec: (run) => (run.startsWith('docker compose up') ? 1 : undefined) });
    h.docker.isRunning = async () => {
      throw new Error('Cannot connect to the Docker daemon');
    };
    await run(h);
    expect(h.reports).toEqual([{ status: 'failed', detail: '"compose up" failed (exit 1).' }]);
  });

  it('reports a failed bring-up and tears down', async () => {
    const h = harness({ healthy: false });
    const res = await run(h, {
      spec: { ...SPEC, environment: { ...SPEC.environment!, healthTimeoutMs: 0 } },
    });
    expect(res.ready).toBe(false);
    expect(h.reports[0]).toMatchObject({ status: 'failed' });
    expect(h.docker.stopContainer).toHaveBeenCalled();
    expect(h.transport.postFinish).toHaveBeenCalledWith('job-1', 1, null);
  });

  it('reports a thrown setup error as lost before finishing, then rethrows', async () => {
    const h = harness();
    const order: string[] = [];
    const post = h.transport.postEnvironment;
    h.transport.postEnvironment = async (id, report) => {
      order.push(`environment:${report.status}`);
      return post(id, report);
    };
    h.transport.postFinish = vi.fn(async () => {
      order.push('finish');
    });
    await expect(
      run(h, {
        materialize: async () => {
          throw new Error('bundle fetch failed: 403');
        },
        spec: { ...SPEC, worktreeRef: { key: 'k' } as RunnerJobWireSpec['worktreeRef'] },
        ensureJobWorktreeOwnership: async () => {},
      }),
    ).rejects.toThrow('bundle fetch failed: 403');
    expect(h.reports).toEqual([{ status: 'lost', detail: 'bundle fetch failed: 403' }]);
    expect(order).toEqual(['environment:lost', 'finish']);
    const logged = (h.transport.postLogs as ReturnType<typeof vi.fn>).mock.calls
      .flatMap((c) => c[1] as Array<{ data: string }>)
      .map((f) => f.data)
      .join('');
    expect(logged).toContain('!! bundle fetch failed: 403');
  });

  it('tears down when the Hub already stopped it before the ready report', async () => {
    const h = harness();
    h.transport.postEnvironment = async () => ({ gone: true });
    const res = await run(h);
    expect(res).toEqual({ ready: false, error: 'stopped' });
    expect(h.docker.stopContainer).toHaveBeenCalled();
  });
});

describe('resolveAdvertiseHost', () => {
  it('prefers the explicit override, then the EC2 private IP, then an interface', async () => {
    const none = async () => null;
    const ifaces = () => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      eth0: [{ address: '172.17.0.9', family: 'IPv4', internal: false }],
    });
    expect(
      await resolveAdvertiseHost({ FINALIZE_RUNNER_ADVERTISE_HOST: 'runner.internal' }, none),
    ).toBe('runner.internal');
    expect(await resolveAdvertiseHost({}, async () => '10.2.3.4', ifaces as never)).toBe(
      '10.2.3.4',
    );
    expect(await resolveAdvertiseHost({}, none, ifaces as never)).toBe('172.17.0.9');
  });
});

describe('createEnvironmentExec deadline', () => {
  const opts = { env: {}, phase: 0, quiet: true };
  const killable: Pick<EnvironmentDocker, 'execStep'> = {
    execStep: (_n, _r, _e, _l, signal) =>
      new Promise((resolve) => {
        if (signal?.aborted) return resolve(1);
        signal?.addEventListener('abort', () => resolve(1), { once: true });
      }),
  };

  it('flags a command killed by its own deadline as timed out', async () => {
    const exec = createEnvironmentExec(killable, 'c', () => {});
    const res = await exec('docker compose up', { ...opts, deadlineMs: 5 });
    expect(res).toMatchObject({ exitCode: 1, timedOut: true });
  });

  it('does not flag a caller stop as a timeout', async () => {
    const exec = createEnvironmentExec(killable, 'c', () => {});
    const ac = new AbortController();
    const p = exec('docker compose up', { ...opts, deadlineMs: 60_000, signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ exitCode: 1, timedOut: false });
  });
});
