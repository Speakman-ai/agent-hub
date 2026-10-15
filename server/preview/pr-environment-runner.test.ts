import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Project } from '../types.js';
import { initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  claimRunnerJob,
  getRunnerJobStatus,
  reapExpiredRunnerLeases,
  reportRunnerJob,
  setRunnerEnvironmentEndpoint,
} from '../finalize/runner-queue.js';
import type { BundleStore } from '../finalize/worktree-bundle.js';
import {
  ENVIRONMENT_GATEWAY_PORT,
  ENVIRONMENT_READY_MARKER,
} from '../finalize/runner-environment.js';
import { createRunnerPrEnvironmentRuntime } from './pr-environment-runner-runtime.js';
import type { PrEnvironmentDto } from './pr-environments.js';
import { isNoSuchContainerError } from '../finalize/runner-agent-environment.js';
import {
  createLocalEnvironmentRunner,
  createRemoteEnvironmentRunner,
  type EnvironmentStartRequest,
  type LocalEnvironmentDocker,
} from './pr-environment-runner.js';

const PROJECT = { id: 'p1' } as Project;
const SHA = 'c'.repeat(40);

const request = (key = 'env-1-aaaa'): EnvironmentStartRequest => ({
  key,
  orgId: 'org-1',
  project: PROJECT,
  prNumber: 5,
  headSha: SHA,
  spec: {
    composeProject: 'pr-5',
    composeFile: 'compose.yml',
    service: 'web',
    port: 8080,
    health: '/',
    steps: [],
  },
  env: { TOKEN: 't' },
});

describe('remote environment runner', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'prenv-remote-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });
  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  const store = { put: vi.fn(), get: vi.fn() } as unknown as BundleStore;

  function make() {
    const removeDir = vi.fn(async () => {});
    const scale = vi.fn();
    const runner = createRemoteEnvironmentRunner({
      store,
      image: 'runner:img',
      prepareCheckout: async () => ({ worktreePath: '/tmp/co', resolvedRef: SHA }),
      createBundle: async (a) => ({ key: a.key, sha256: 'abc', sizeBytes: 1 }),
      removeDir,
      scale,
      now: () => 1_000,
    });
    return { runner, removeDir, scale };
  }

  it('enqueues an environment job pinned to the head commit and scales the fleet', async () => {
    const { runner, removeDir, scale } = make();
    const ref = await runner.start(request());
    expect(removeDir).toHaveBeenCalledWith('/tmp/co');
    expect(scale).toHaveBeenCalled();
    expect(getRunnerJobStatus(ref)).toMatchObject({ kind: 'environment', state: 'queued' });
    const claimed = claimRunnerJob({ agentId: 'a1', leaseMs: 60_000, now: 2_000 });
    const spec = JSON.parse(claimed!.specJson);
    expect(spec).toMatchObject({
      kind: 'environment',
      headSha: SHA,
      composeProjectName: 'pr-5',
      env: { TOKEN: 't' },
      resourceProfile: 'unconstrained',
      minimalEnv: true,
      environment: { service: 'web', port: 8080 },
      worktreeRef: { sha256: 'abc' },
    });
    expect(await runner.status(ref)).toMatchObject({ state: 'starting' });
    setRunnerEnvironmentEndpoint({
      jobId: ref,
      agentId: 'a1',
      endpoint: { host: '10.0.0.4', port: 32111 },
      now: 3_000,
    });
    expect(await runner.status(ref)).toEqual({
      state: 'ready',
      upstream: { host: '10.0.0.4', port: 32111 },
      detail: null,
    });
  });

  it('an agent-reported loss during bring-up is requeued by the runtime', async () => {
    const { runner } = make();
    const rt = createRunnerPrEnvironmentRuntime({
      runner,
      readPreviewConfig: async () => ({
        compose: 'compose.yml',
        service: 'web',
        port: 8080,
        health: '/',
        healthTimeoutMinutes: 5,
        steps: [],
        secrets: [],
      }),
      resolveSecrets: () => ({}),
      orgId: () => 'org-1',
      startTimer: () => ({ stop: () => {} }),
      log: () => {},
    });
    const r = { building: vi.fn(), ready: vi.fn(), failed: vi.fn(), lost: vi.fn(), log: vi.fn() };
    await rt.build({
      project: PROJECT,
      env: { id: 'env-1', prNumber: 5, headSha: SHA } as PrEnvironmentDto,
      reporter: r,
    });
    const ref = r.building.mock.calls[0][0] as string;
    claimRunnerJob({ agentId: 'a1', leaseMs: 60_000, now: 2_000 });
    // What POST /environment {status:'lost'} records.
    reportRunnerJob({
      jobId: ref,
      state: 'lost',
      detail: 'the environment container stopped during bring-up',
      now: 3_000,
    });
    await rt.tick();
    expect(r.failed).not.toHaveBeenCalled();
    expect(r.lost).toHaveBeenCalledWith(expect.stringContaining('stopped during bring-up'), {
      requeue: true,
    });
  });

  it('a reaped lease reads as lost; stop cancels idempotently', async () => {
    const { runner } = make();
    const ref = await runner.start(request());
    claimRunnerJob({ agentId: 'a1', leaseMs: 1_000, now: 2_000 });
    reapExpiredRunnerLeases(10_000);
    expect(await runner.status(ref)).toMatchObject({ state: 'lost' });

    const other = await runner.start(request('env-2-bbbb'));
    await runner.stop(other);
    await runner.stop(other);
    expect(await runner.status(other)).toMatchObject({ state: 'stopped' });
  });

  it('refuses to start without a worktree store', async () => {
    const runner = createRemoteEnvironmentRunner({ store: null });
    await expect(runner.start(request())).rejects.toThrow(/no worktree store/);
  });
});

function fakeDocker(state: {
  running: boolean | null;
  ready: boolean;
  inspectErrors?: number;
  killDuring?: string;
}) {
  const execs: string[] = [];
  const docker: LocalEnvironmentDocker & { start: ReturnType<typeof vi.fn> } = {
    start: vi.fn(async () => {
      state.running = true;
    }),
    startContainer: vi.fn(),
    async execStep(_name, run, _env, onLog) {
      execs.push(run);
      if (state.killDuring && run.startsWith(state.killDuring)) {
        state.running = false;
        return 137;
      }
      if (run.startsWith('curl')) onLog('stdout', '200');
      if (run.startsWith('touch')) state.ready = true;
      return 0;
    },
    hostPort: vi.fn(async () => 40001),
    stopContainer: vi.fn(async () => {
      state.running = null;
    }),
    isRunning: async () => {
      if (state.inspectErrors) {
        state.inspectErrors -= 1;
        throw Object.assign(new Error('Cannot connect to the Docker daemon'), { stderr: 'x' });
      }
      return state.running;
    },
    hasFile: async (_n, f) => f === ENVIRONMENT_READY_MARKER && state.ready,
  };
  return { docker, execs };
}

const settle = async (cond: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error('condition not reached');
};

describe('local environment runner', () => {
  const base = (docker: LocalEnvironmentDocker, env: NodeJS.ProcessEnv = {}) =>
    createLocalEnvironmentRunner({
      docker,
      env,
      root: '/ws/.pr-environments',
      image: 'runner:img',
      prepareCheckout: vi.fn(async () => ({ worktreePath: 'x', resolvedRef: SHA })),
      removeDir: async () => {},
      containerCheckRetryMs: 1,
      healthPollMs: 1,
    });

  it('boots the stack in a DinD container with the gateway published on loopback', async () => {
    const state = { running: null as boolean | null, ready: false };
    const { docker, execs } = fakeDocker(state);
    const runner = base(docker);
    const ref = await runner.start(request());
    expect(docker.start).toHaveBeenCalledWith(
      expect.objectContaining({
        containerName: 'prenv-env-1-aaaa',
        worktreePath: '/ws/.pr-environments/env-1-aaaa',
        publish: [{ containerPort: ENVIRONMENT_GATEWAY_PORT, hostIp: '127.0.0.1' }],
        baseEnvOnly: true,
      }),
    );
    await settle(async () => (await runner.status(ref)).state === 'ready');
    expect(await runner.status(ref)).toMatchObject({
      upstream: { host: '127.0.0.1', port: 40001 },
    });
    expect(execs).toContain('docker compose up -d --no-build --remove-orphans');
    const logs = await runner.readLogs(ref, -1);
    expect(logs.lines).toContain('==> environment is healthy');
  });

  it('after a Hub restart reads a healthy stack back from docker, and an interrupted one as lost', async () => {
    const state = { running: true as boolean | null, ready: true };
    const { docker } = fakeDocker(state);
    const fresh = base(docker, { AGENT_HUB_PREVIEW_HEALTH_HOST: 'host.docker.internal' });
    expect(await fresh.status('env-1-aaaa')).toEqual({
      state: 'ready',
      upstream: { host: 'host.docker.internal', port: 40001 },
      detail: null,
    });
    state.ready = false;
    expect(await base(docker).status('env-1-aaaa')).toMatchObject({
      state: 'lost',
      detail: 'bring-up was interrupted by a Hub restart',
    });
    state.running = null;
    expect(await base(docker).status('env-1-aaaa')).toMatchObject({ state: 'lost' });
  });

  it('a container that dies during a seed step is lost (requeued), not failed', async () => {
    const state = {
      running: null as boolean | null,
      ready: false,
      killDuring: 'docker compose up',
    };
    const { docker } = fakeDocker(state);
    const runner = base(docker);
    const rt = createRunnerPrEnvironmentRuntime({
      runner,
      readPreviewConfig: async () => ({
        compose: 'compose.yml',
        service: 'web',
        port: 8080,
        health: '/',
        healthTimeoutMinutes: 5,
        steps: [],
        secrets: [],
      }),
      resolveSecrets: () => ({}),
      orgId: () => 'o',
      startTimer: () => ({ stop: () => {} }),
      log: () => {},
    });
    const r = { building: vi.fn(), ready: vi.fn(), failed: vi.fn(), lost: vi.fn(), log: vi.fn() };
    await rt.build({
      project: PROJECT,
      env: { id: 'env-1', prNumber: 5, headSha: SHA } as PrEnvironmentDto,
      reporter: r,
    });
    const ref = r.building.mock.calls[0][0] as string;
    await settle(async () => (await runner.status(ref)).state !== 'starting');
    expect(await runner.status(ref)).toMatchObject({
      state: 'lost',
      detail: 'the environment container stopped during bring-up',
    });
    await rt.tick();
    expect(r.failed).not.toHaveBeenCalled();
    expect(r.lost).toHaveBeenCalledWith(expect.any(String), { requeue: true });
  });

  it('is never ready when the ready marker could not be written', async () => {
    const state = { running: null as boolean | null, ready: false };
    const { docker } = fakeDocker(state);
    const exec = docker.execStep;
    docker.execStep = async (n, run, e, onLog, sig) =>
      run.startsWith('touch') ? 1 : exec(n, run, e, onLog, sig);
    const runner = base(docker);
    const ref = await runner.start(request());
    await settle(async () => (await runner.status(ref)).state !== 'starting');
    expect(await runner.status(ref)).toMatchObject({
      state: 'failed',
      detail: 'Could not record the environment as ready (exit 1).',
    });
  });

  it('a bring-up failure with the container still up stays failed', async () => {
    const state = { running: null as boolean | null, ready: false };
    const { docker } = fakeDocker(state);
    docker.execStep = async (_n, run) => (run.startsWith('docker compose up') ? 1 : 0);
    const runner = base(docker);
    const ref = await runner.start(request());
    await settle(async () => (await runner.status(ref)).state !== 'starting');
    expect(await runner.status(ref)).toMatchObject({ state: 'failed' });
  });

  it('detects a ready container that died, and stop is idempotent', async () => {
    const state = { running: null as boolean | null, ready: false };
    const { docker, execs } = fakeDocker(state);
    const runner = base(docker);
    const ref = await runner.start(request());
    await settle(async () => (await runner.status(ref)).state === 'ready');
    state.running = false;
    expect(await runner.status(ref)).toMatchObject({ state: 'lost' });
    state.running = true;
    await runner.stop(ref);
    await runner.stop(ref);
    expect(execs.filter((r) => r.startsWith('docker compose down'))).toHaveLength(1);
    expect(docker.stopContainer).toHaveBeenCalledTimes(2);
    expect(await runner.status(ref)).toMatchObject({ state: 'stopped' });
  });

  describe('a docker error is not a lost environment', () => {
    const reporter = () => ({
      building: vi.fn(),
      ready: vi.fn(),
      failed: vi.fn(),
      lost: vi.fn(),
      log: vi.fn(),
    });
    const runtimeFor = (runner: ReturnType<typeof base>) =>
      createRunnerPrEnvironmentRuntime({
        runner,
        readPreviewConfig: async () => null,
        resolveSecrets: () => ({}),
        orgId: () => 'o',
        startTimer: () => ({ stop: () => {} }),
        log: () => {},
      });
    const dto = { id: 'env-1', runnerRef: 'env-1-aaaa', status: 'ready' } as PrEnvironmentDto;

    it('keeps a ready environment through one failed inspection', async () => {
      const state = { running: null as boolean | null, ready: false, inspectErrors: 0 };
      const { docker } = fakeDocker(state);
      const runner = base(docker);
      const ref = await runner.start(request());
      await settle(async () => (await runner.status(ref)).state === 'ready');
      state.inspectErrors = 1;
      await expect(runner.status(ref)).rejects.toThrow(/Docker daemon/);
      expect(await runner.status(ref)).toMatchObject({ state: 'ready' });

      // Through the runtime: the failed poll is skipped, not reported.
      const rt = runtimeFor(runner);
      const r = reporter();
      expect(
        await rt.reattach!({ project: PROJECT, env: { ...dto, runnerRef: ref }, reporter: r }),
      ).toBe(true);
      state.inspectErrors = 1;
      await rt.tick();
      await rt.tick();
      expect(r.lost).not.toHaveBeenCalled();
      expect(rt.watched()).toEqual([ref]);
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    it('adopts a healthy stack after a restart even when the first inspection fails', async () => {
      const state = { running: true as boolean | null, ready: true, inspectErrors: 1 };
      const { docker } = fakeDocker(state);
      const rt = runtimeFor(base(docker));
      const r = reporter();
      expect(await rt.reattach!({ project: PROJECT, env: dto, reporter: r })).toBe(true);
      expect(r.lost).not.toHaveBeenCalled();
      await rt.tick();
      expect(r.ready).toHaveBeenCalledWith('http://127.0.0.1:40001');
      expect(r.lost).not.toHaveBeenCalled();
      expect(docker.stopContainer).not.toHaveBeenCalled();
    });

    it('a confirmed missing container is still lost', async () => {
      expect(isNoSuchContainerError({ stderr: 'Error: No such object: prenv-x' })).toBe(true);
      expect(isNoSuchContainerError({ stderr: 'Cannot connect to the Docker daemon' })).toBe(false);
      const { docker } = fakeDocker({ running: null, ready: false });
      expect(await base(docker).status('env-1-aaaa')).toMatchObject({ state: 'lost' });
    });
  });
});
