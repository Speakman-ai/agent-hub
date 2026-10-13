import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PR_ENVIRONMENTS_SCHEMA } from './pr-environments-schema.js';
import {
  createPrEnvironmentService,
  createPrEnvironmentStore,
  PR_ENVIRONMENT_LOG_TAIL_LINES,
  onPrEnvironmentRuntimeRegistered,
  createOrgScopedPrEnvironmentService,
  prEnvironmentPanelVisible,
  PR_TEARDOWN_RETRY_MS,
  setPrEnvironmentRuntime,
  type PrEnvironmentReporter,
  type PrEnvironmentRuntime,
} from './pr-environments.js';
import type { Project, PullRequestRow } from '../types.js';
import { readNativePrState } from './pr-environment-native.js';
import type { PrAuthoritativeState } from './pr-environments.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const project = { id: 'p1' } as Project;
const PR = { source: 'native' as const, prNumber: 7 };

function setup(
  opts: {
    hasConfig?: boolean;
    runtime?: PrEnvironmentRuntime | null;
    onReady?: (project: Project, env: { status: string; headSha: string }) => void;
  } = {},
) {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENTS_SCHEMA);
  const reporters: PrEnvironmentReporter[] = [];
  const runtime =
    opts.runtime === undefined
      ? {
          build: vi.fn(({ reporter }: { reporter: PrEnvironmentReporter }) => {
            reporters.push(reporter);
          }),
          teardown: vi.fn(),
        }
      : opts.runtime;
  const broadcast = vi.fn();
  let clock = 1_000;
  // true/false map to present/absent; a string is passed through ('unresolved').
  const hasPreviewConfig = vi
    .fn<(...args: unknown[]) => Promise<boolean | 'unresolved'>>()
    .mockResolvedValue(opts.hasConfig ?? true);
  let currentRuntime = runtime;
  const service = createPrEnvironmentService({
    store: createPrEnvironmentStore(db),
    probePreviewConfig: async (...args) => {
      const v = await hasPreviewConfig(...args);
      return v === true ? 'present' : v === false ? 'absent' : v;
    },
    findProject: (id) => (id === project.id ? project : null),
    broadcast,
    onReady: opts.onReady,
    getRuntime: () => currentRuntime,
    now: () => (clock += 1),
    log: () => {},
  });
  const setRuntime = (rt: PrEnvironmentRuntime | null) => {
    currentRuntime = rt;
  };
  return { db, service, runtime, reporters, broadcast, hasPreviewConfig, setRuntime };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
/** readState for a manual start on an open PR at `headSha`. */
const openAt =
  (headSha: string, headBranch: string | null = null) =>
  async () => ({ status: 'open' as const, headSha, headBranch });

describe('PrEnvironmentService', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('queues on manual start and hands the build to the runtime', async () => {
    const res = await ctx.service.start(project, PR, openAt(SHA_A, 'x'));
    expect(res).toMatchObject({
      ok: true,
      environment: { status: 'queued', headSha: SHA_A, prNumber: 7, source: 'native' },
    });
    await flush();
    expect(ctx.runtime!.build).toHaveBeenCalledTimes(1);
    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pr_environment_update', status: 'queued', prNumber: 7 }),
    );
  });

  it('a PR-open event creates nothing: environments are opt-in', async () => {
    const { service, runtime, hasPreviewConfig } = setup();
    expect(await service.onPrOpened(project, { ...PR, headSha: SHA_A, headBranch: null })).toBe(
      null,
    );
    await flush();
    expect(hasPreviewConfig).not.toHaveBeenCalled();
    expect(runtime!.build).not.toHaveBeenCalled();
    expect(service.get('p1', PR)).toBeNull();
  });

  it('reconcile with no environment returns null without reading the PR', async () => {
    const { service, runtime, hasPreviewConfig } = setup();
    const read = vi.fn(openAt(SHA_A));
    expect(await service.reconcile(project, PR, read)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(hasPreviewConfig).not.toHaveBeenCalled();
    expect(runtime!.build).not.toHaveBeenCalled();
    expect(service.get('p1', PR)).toBeNull();
  });

  it('runtime progress lands on the row, with a capped log tail', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    await flush();
    const reporter = ctx.reporters[0];
    reporter.building('runner-1');
    expect(ctx.service.get('p1', PR)).toMatchObject({ status: 'building', runnerRef: 'runner-1' });
    reporter.log(Array.from({ length: PR_ENVIRONMENT_LOG_TAIL_LINES + 5 }, (_, i) => `l${i}`));
    reporter.ready('http://pr-7.local');
    const env = ctx.service.get('p1', PR)!;
    expect(env).toMatchObject({ status: 'ready', url: 'http://pr-7.local' });
    expect(env.readyAt).not.toBeNull();
    expect(env.logTail).toHaveLength(PR_ENVIRONMENT_LOG_TAIL_LINES);
    expect(env.logTail.at(-1)).toBe(`l${PR_ENVIRONMENT_LOG_TAIL_LINES + 4}`);
  });

  it('calls onReady once per build that becomes ready, and never for a stale one', async () => {
    const onReady = vi.fn();
    const { service, reporters } = setup({ onReady });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    reporters[0].building();
    reporters[0].ready('http://a');
    reporters[0].ready('http://a');
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady.mock.calls[0][1]).toMatchObject({ status: 'ready', headSha: SHA_A });

    await service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    await flush();
    reporters[0].ready('http://stale');
    reporters[1].ready('http://b');
    await flush();
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady.mock.calls[1][1]).toMatchObject({ headSha: SHA_B });
  });

  it('catch-up re-runs onReady for ready environments, so a failed announcement is retried', async () => {
    const onReady = vi
      .fn()
      .mockRejectedValueOnce(new Error('GitHub 502'))
      .mockResolvedValue(undefined);
    const { service, reporters } = setup({ onReady });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    reporters[0].ready('http://a');
    await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    await service.catchUp();
    expect(onReady).toHaveBeenCalledTimes(2);
    expect(onReady.mock.calls[1][1]).toMatchObject({ status: 'ready', headSha: SHA_A });
    expect(service.get('p1', PR)).toMatchObject({ status: 'ready' });
  });

  it('catch-up does not announce environments that are not ready', async () => {
    const onReady = vi.fn();
    const { service } = setup({ onReady });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    await service.catchUp();
    expect(onReady).not.toHaveBeenCalled();
  });

  it('a throwing onReady does not break the lifecycle', async () => {
    const { service, reporters } = setup({
      onReady: () => {
        throw new Error('boom');
      },
    });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    reporters[0].ready('http://a');
    await flush();
    expect(service.get('p1', PR)).toMatchObject({ status: 'ready' });
  });

  it('a new head sha rebuilds and drops the old build’s late callbacks', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    await flush();
    const oldReporter = ctx.reporters[0];
    oldReporter.log('old line');

    await ctx.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    await flush();
    expect(ctx.runtime!.teardown).toHaveBeenCalledTimes(1);
    expect(ctx.runtime!.build).toHaveBeenCalledTimes(2);

    oldReporter.ready('http://stale');
    oldReporter.log('stale line');
    const env = ctx.service.get('p1', PR)!;
    expect(env).toMatchObject({ status: 'queued', headSha: SHA_B, url: null });
    expect(env.logTail).toEqual([]);
  });

  it('merge tears down and marks stopped', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    const env = await ctx.service.onPrClosed(project, { ...PR, merged: true });
    expect(env).toMatchObject({ status: 'stopped', stopReason: 'merged' });
    expect(env!.stoppedAt).not.toBeNull();
    expect(ctx.runtime!.teardown).toHaveBeenCalledTimes(1);
  });

  it('stops a running env when a new head drops the preview block', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    ctx.hasPreviewConfig.mockResolvedValueOnce(false);
    const env = await ctx.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    expect(env).toMatchObject({ status: 'stopped', stopReason: 'no_preview_config' });
  });

  it('a build that throws marks the env failed', async () => {
    const { service } = setup({
      runtime: {
        build: () => {
          throw new Error('compose up failed');
        },
        teardown: vi.fn(),
      },
    });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    expect(service.get('p1', PR)).toMatchObject({ status: 'failed', error: 'compose up failed' });
  });

  it('with no runtime registered the env stays queued', async () => {
    const { service } = setup({ runtime: null });
    await service.start(project, PR, openAt(SHA_A));
    await flush();
    expect(service.get('p1', PR)).toMatchObject({ status: 'queued' });
  });

  it('manual start reports a missing preview block instead of creating a row', async () => {
    const { service } = setup({ hasConfig: false });
    const res = await service.start(project, PR, openAt(SHA_A));
    expect(res).toMatchObject({ ok: false, reason: 'no_preview_config' });
    expect(service.get('p1', PR)).toBeNull();
  });

  it('serializes events per PR so a slow config read cannot reorder open and close', async () => {
    let release!: (v: boolean | 'unresolved') => void;
    ctx.hasPreviewConfig.mockImplementationOnce(
      () => new Promise<boolean | 'unresolved'>((r) => (release = r)),
    );
    const opening = ctx.service.start(project, PR, openAt(SHA_A));
    const closing = ctx.service.onPrClosed(project, { ...PR, merged: false });
    await flush();
    release(true);
    await opening;
    const final = await closing;
    expect(final).toMatchObject({ status: 'stopped', stopReason: 'closed' });
  });

  it('keeps environments separate per PR and project', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    await ctx.service.start(project, { source: 'native', prNumber: 8 }, openAt(SHA_B));
    expect(ctx.service.get('p1', PR)!.headSha).toBe(SHA_A);
    expect(ctx.service.get('p1', { source: 'native', prNumber: 8 })!.headSha).toBe(SHA_B);
    expect(ctx.service.get('p2', PR)).toBeNull();
    expect(ctx.service.list('p1')).toHaveLength(2);
  });

  it('a head that drops the preview block is recorded, and start then refuses it', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A, 'x'));
    ctx.hasPreviewConfig.mockImplementation(async (_p: unknown, sha: unknown) => sha === SHA_A);
    const removed = await ctx.service.onPrOpened(project, {
      ...PR,
      headSha: SHA_B,
      headBranch: 'x',
    });
    expect(removed).toMatchObject({
      status: 'stopped',
      stopReason: 'no_preview_config',
      headSha: SHA_B,
    });

    // A start at the recorded head must check B, which has no block.
    const recorded = ctx.service.get('p1', PR)!;
    const res = await ctx.service.start(project, PR, openAt(recorded.headSha, recorded.headBranch));
    expect(res).toMatchObject({ ok: false, reason: 'no_preview_config' });
    await flush();
    expect(ctx.runtime!.build).toHaveBeenCalledTimes(1); // only the original build of A
    expect(ctx.service.get('p1', PR)).toMatchObject({ status: 'stopped', headSha: SHA_B });
  });

  it('an unreadable head is recorded as failed at that head, not guessed from another revision', async () => {
    await ctx.service.start(project, PR, openAt(SHA_A));
    await flush();
    ctx.hasPreviewConfig.mockResolvedValue('unresolved');
    const env = await ctx.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    expect(env).toMatchObject({ status: 'failed', headSha: SHA_B, url: null });
    expect(env!.error).toMatch(/Could not read head commit/);
    expect(ctx.runtime!.teardown).toHaveBeenCalledTimes(1); // A's stack is obsolete

    // Late callbacks from A's build cannot revive it.
    ctx.reporters[0].ready('http://stale');
    expect(ctx.service.get('p1', PR)).toMatchObject({ status: 'failed', headSha: SHA_B });

    // Manual start re-probes; still unreadable → refused, nothing built.
    const res = await ctx.service.start(project, PR, openAt(SHA_B));
    expect(res).toMatchObject({ ok: false, reason: 'unresolved_head' });

    // Once the commit is readable, start builds B.
    ctx.hasPreviewConfig.mockResolvedValue(true);
    const ok = await ctx.service.start(project, PR, openAt(SHA_B));
    expect(ok).toMatchObject({ ok: true, environment: { status: 'queued', headSha: SHA_B } });
    await flush();
    expect(ctx.runtime!.build).toHaveBeenCalledTimes(2);
  });

  it('rows queued with no runtime are dispatched once a runtime registers, exactly once', async () => {
    const c = setup({ runtime: null });
    await c.service.start(project, PR, openAt(SHA_A));
    await c.service.start(project, { source: 'native', prNumber: 8 }, openAt(SHA_B));
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 0, dispatched: 0 }); // still no runtime

    const runtime = { build: vi.fn(), teardown: vi.fn() };
    c.setRuntime(runtime);
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 0, dispatched: 2 });
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(2);

    // Registering again (or a same-sha start) does not double-dispatch.
    expect((await c.service.recoverPending()).dispatched).toBe(0);
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(2);
  });

  it('a same-sha start dispatches a row that was queued before the runtime existed', async () => {
    const c = setup({ runtime: null });
    await c.service.start(project, PR, openAt(SHA_A));
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    c.setRuntime(runtime);
    const res = await c.service.start(project, PR, openAt(SHA_A));
    expect(res).toMatchObject({ ok: true, environment: { status: 'queued', headSha: SHA_A } });
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });
});

describe('setPrEnvironmentRuntime', () => {
  it('notifies registration listeners so queued rows can be dispatched', () => {
    const listener = vi.fn();
    const off = onPrEnvironmentRuntimeRegistered(listener);
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    try {
      setPrEnvironmentRuntime(runtime);
      expect(listener).toHaveBeenCalledWith(runtime);
      setPrEnvironmentRuntime(null);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      off();
      setPrEnvironmentRuntime(null);
    }
  });
});

describe('teardown failures', () => {
  it('a teardown that fails once is retried by the next stop and then succeeds', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    (c.runtime!.teardown as any).mockRejectedValueOnce(new Error('docker daemon unreachable'));

    const first = await c.service.stop(project, PR);
    expect(first).toMatchObject({ status: 'stopped', cleanupPending: true });
    expect(first!.error).toMatch(/Teardown failed: docker daemon unreachable/);

    const second = await c.service.stop(project, PR);
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ status: 'stopped', cleanupPending: false, error: null });

    // Nothing left to clean: a third stop is a no-op.
    await c.service.stop(project, PR);
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(2);
  });

  it('a close retries a teardown that failed on an earlier stop', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    (c.runtime!.teardown as any).mockRejectedValueOnce(new Error('boom'));
    await c.service.stop(project, PR);
    const closed = await c.service.onPrClosed(project, { ...PR, merged: true });
    expect(closed).toMatchObject({ stopReason: 'merged', cleanupPending: false });
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(2);
  });

  it('a replacement build does not start over a failed teardown; Retry tears down then builds', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);

    (c.runtime!.teardown as any).mockRejectedValueOnce(new Error('stack stuck'));
    const pushed = await c.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    await flush();
    expect(pushed).toMatchObject({ status: 'failed', headSha: SHA_B, cleanupPending: true });
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);

    const retry = await c.service.start(project, PR, openAt(SHA_B));
    await flush();
    expect(retry).toMatchObject({
      ok: true,
      environment: { status: 'queued', cleanupPending: false },
    });
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(2);
    expect(c.runtime!.build).toHaveBeenCalledTimes(2);
  });
});

describe('native reconcile vs. a racing close', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('a head lookup that resolves after the PR closed does not requeue it', async () => {
    const c = setup();
    const prRow = {
      number: 7,
      head_branch: 'fix/x',
      head_sha: SHA_A,
      status: 'open',
    } as PullRequestRow;
    const lookup = deferred<string | null>();
    const deps = {
      getPr: () => prRow,
      revParseHead: vi.fn(() => lookup.promise),
    };
    const read = () => readNativePrState(deps, 'p1', 7);

    // Env already running at A.
    await c.service.start(project, PR, openAt(SHA_A, 'fix/x'));

    // A push starts reconciling; its head lookup is slow.
    const pushSync = c.service.reconcile(project, PR, read);
    await flush();
    expect(deps.revParseHead).toHaveBeenCalledTimes(1);

    // The PR closes meanwhile; the close hook reconciles too.
    (prRow as { status: string }).status = 'closed';
    const closeSync = c.service.reconcile(project, PR, read);

    lookup.resolve(SHA_B);
    await pushSync;
    const final = await closeSync;
    await flush();
    expect(final).toMatchObject({ status: 'stopped', stopReason: 'closed' });
    expect(c.runtime!.build).toHaveBeenCalledTimes(1); // only the original build of A
  });

  it('merged before the lookup returns → stopped as merged, never rebuilt', async () => {
    const c = setup();
    const prRow = {
      number: 7,
      head_branch: 'fix/x',
      head_sha: SHA_A,
      status: 'open',
    } as PullRequestRow;
    const lookup = deferred<string | null>();
    const read = () =>
      readNativePrState({ getPr: () => prRow, revParseHead: () => lookup.promise }, 'p1', 7);
    await c.service.start(project, PR, openAt(SHA_A, 'fix/x'));

    const pushSync = c.service.reconcile(project, PR, read);
    await flush();
    (prRow as { status: string }).status = 'merged';
    lookup.resolve(SHA_B);
    const env = await pushSync;
    expect(env).toMatchObject({ status: 'stopped', stopReason: 'merged', headSha: SHA_A });
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);
  });

  it('an open PR reconciles to its live head', async () => {
    const c = setup();
    const prRow = {
      number: 7,
      head_branch: 'fix/x',
      head_sha: SHA_A,
      status: 'open',
    } as PullRequestRow;
    await c.service.start(project, PR, openAt(SHA_A, 'fix/x'));
    const env = await c.service.reconcile(project, PR, () =>
      readNativePrState({ getPr: () => prRow, revParseHead: async () => SHA_B }, 'p1', 7),
    );
    expect(env).toMatchObject({ status: 'queued', headSha: SHA_B, headBranch: 'fix/x' });
  });
});

describe('recovery when the runtime comes back', () => {
  it('a close while the runtime is absent is torn down once a runtime registers', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);

    // Runtime goes away (restart, outage); the PR closes meanwhile.
    c.setRuntime(null);
    const closed = await c.service.onPrClosed(project, { ...PR, merged: false });
    expect(closed).toMatchObject({ status: 'stopped', stopReason: 'closed', cleanupPending: true });
    expect(c.runtime!.teardown).not.toHaveBeenCalled();

    // A runtime registers: the pending teardown runs, nothing is rebuilt.
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    c.setRuntime(runtime);
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 1, dispatched: 0 });
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
    expect(runtime.build).not.toHaveBeenCalled();
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'stopped', cleanupPending: false });

    // Idempotent: nothing left to recover.
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 0, dispatched: 0 });
  });

  it('a teardown interrupted by a failure is retried on recovery', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    (c.runtime!.teardown as any).mockRejectedValueOnce(new Error('daemon restarting'));
    await c.service.stop(project, PR);
    expect(c.service.get('p1', PR)).toMatchObject({ cleanupPending: true });
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 1, dispatched: 0 });
    expect(c.service.get('p1', PR)).toMatchObject({ cleanupPending: false });
  });
});

describe('manual start reads PR state inside the queue', () => {
  it('refuses when readState reports the PR closed or missing', async () => {
    const c = setup();
    expect(
      await c.service.start(project, PR, async () => ({ status: 'closed' as const })),
    ).toMatchObject({ ok: false, reason: 'not_open' });
    expect(await c.service.start(project, PR, async () => null)).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(c.service.get('p1', PR)).toBeNull();
  });

  it('a close reconciled while the start is waiting wins; nothing is rebuilt', async () => {
    const c = setup();
    const prRow = {
      number: 7,
      head_branch: 'fix/x',
      head_sha: SHA_A,
      status: 'open',
    } as PullRequestRow;
    let release!: (v: string | null) => void;
    const lookup = new Promise<string | null>((r) => (release = r));
    const deps = { getPr: () => prRow, revParseHead: vi.fn(() => lookup) };
    await c.service.start(project, PR, openAt(SHA_A, 'fix/x'));
    await c.service.stop(project, PR);

    const starting = c.service.start(project, PR, () => readNativePrState(deps, 'p1', 7));
    await flush();
    expect(deps.revParseHead).toHaveBeenCalledTimes(1);
    (prRow as { status: string }).status = 'closed';
    const closing = c.service.reconcile(project, PR, () =>
      readNativePrState({ getPr: () => prRow, revParseHead: async () => SHA_A }, 'p1', 7),
    );
    release(SHA_B);

    expect(await starting).toMatchObject({ ok: false, reason: 'not_open' });
    expect(await closing).toMatchObject({ status: 'stopped', stopReason: 'closed' });
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);
  });
});

describe('cleanup target survives the replacement row', () => {
  it('retries of a failed teardown receive the original runner reference', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');

    const teardown = c.runtime!.teardown as any;
    teardown.mockRejectedValueOnce(new Error('docker down'));
    await c.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    expect(teardown.mock.calls[0][0].env).toMatchObject({ runnerRef: 'runner-A', headSha: SHA_A });
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'failed', runnerRef: null });

    // Manual retry: the teardown still targets runner-A, then B builds.
    await c.service.start(project, PR, openAt(SHA_B));
    expect(teardown.mock.calls[1][0].env).toMatchObject({ runnerRef: 'runner-A', headSha: SHA_A });
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(2);

    // Retry via recovery after another failure keeps the target too.
    c.reporters[1].building('runner-B');
    teardown.mockRejectedValueOnce(new Error('again'));
    await c.service.stop(project, PR);
    expect(teardown.mock.calls[2][0].env).toMatchObject({ runnerRef: 'runner-B' });
    await c.service.recoverPending();
    expect(teardown.mock.calls[3][0].env).toMatchObject({ runnerRef: 'runner-B' });
    expect(c.service.get('p1', PR)).toMatchObject({ cleanupPending: false });
  });

  it('a head update while the runtime is absent tears down the old runner on recovery', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');

    c.setRuntime(null);
    await c.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    expect(c.service.get('p1', PR)).toMatchObject({
      status: 'queued',
      headSha: SHA_B,
      runnerRef: null,
      cleanupPending: true,
    });

    const runtime = { build: vi.fn(), teardown: vi.fn() };
    c.setRuntime(runtime);
    expect(await c.service.recoverPending()).toMatchObject({ tornDown: 0, dispatched: 1 });
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
    expect(runtime.teardown.mock.calls[0][0].env).toMatchObject({
      runnerRef: 'runner-A',
      headSha: SHA_A,
    });
    await flush();
    expect(runtime.build.mock.calls[0][0].env).toMatchObject({ headSha: SHA_B });
  });
});

describe('manual stop intent over a no-preview stop', () => {
  it('config removed → manual stop → config restored does not rebuild', async () => {
    const c = setup();
    c.hasPreviewConfig.mockImplementation(async (_p: unknown, sha: unknown) => sha !== SHA_B);
    await c.service.start(project, PR, openAt(SHA_A));
    await c.service.onPrOpened(project, { ...PR, headSha: SHA_B, headBranch: null });
    expect(c.service.get('p1', PR)).toMatchObject({ stopReason: 'no_preview_config' });

    const stopped = await c.service.stop(project, PR);
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'manual' });

    const SHA_C = 'c'.repeat(40);
    const restored = await c.service.onPrOpened(project, {
      ...PR,
      headSha: SHA_C,
      headBranch: null,
    });
    expect(restored).toMatchObject({ status: 'stopped', stopReason: 'manual', headSha: SHA_C });
    await flush();
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);
  });
});

describe('builds interrupted by a Hub restart', () => {
  /** A fresh service over the same database: what a Hub restart looks like. */
  function restart(db: InstanceType<typeof Database>, runtime: PrEnvironmentRuntime) {
    return createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: (id) => (id === project.id ? project : null),
      getRuntime: () => runtime,
      log: () => {},
    });
  }

  it('a building row with no runtime reattach is failed, cleaned up, and Retry rebuilds', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'building' });

    const runtime = { build: vi.fn(), teardown: vi.fn() };
    const after = restart(c.db, runtime);
    expect(await after.recoverPending()).toMatchObject({ interrupted: 1, reattached: 0 });

    const env = after.get('p1', PR)!;
    expect(env).toMatchObject({ status: 'failed', cleanupPending: false });
    expect(env.error).toMatch(/interrupted/);
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
    expect(runtime.teardown.mock.calls[0][0].env).toMatchObject({ runnerRef: 'runner-A' });

    // Late callbacks from the dead build's reporter cannot revive it.
    c.reporters[0].ready('http://stale');
    expect(after.get('p1', PR)).toMatchObject({ status: 'failed' });

    // Retry at the same sha rebuilds.
    const retry = await after.start(project, PR, openAt(SHA_A));
    expect(retry).toMatchObject({ ok: true, environment: { status: 'queued' } });
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);

    // Nothing left for recovery to do.
    expect(await after.recoverPending()).toMatchObject({ interrupted: 0, dispatched: 0 });
  });

  it('a runtime that still tracks the build adopts it and reports through a new reporter', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');

    let adopted: PrEnvironmentReporter | null = null;
    const runtime: PrEnvironmentRuntime = {
      build: vi.fn(),
      teardown: vi.fn(),
      reattach: vi.fn(({ reporter }) => {
        adopted = reporter;
        return true;
      }),
    };
    const after = restart(c.db, runtime);
    expect(await after.recoverPending()).toMatchObject({ reattached: 1, interrupted: 0 });
    expect(after.get('p1', PR)).toMatchObject({ status: 'building' });
    adopted!.ready('http://pr-7.local');
    expect(after.get('p1', PR)).toMatchObject({ status: 'ready', url: 'http://pr-7.local' });
    expect(runtime.teardown).not.toHaveBeenCalled();
    // Adopted once; a second recovery leaves it alone.
    expect(await after.recoverPending()).toMatchObject({ reattached: 0, interrupted: 0 });
  });

  it('a ready environment is re-watched after a restart, even when the PR read fails', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    c.reporters[0].ready('http://10.0.0.1:32000');

    let adopted: PrEnvironmentReporter | null = null;
    const runtime: PrEnvironmentRuntime = {
      build: vi.fn(),
      teardown: vi.fn(),
      reattach: vi.fn(({ reporter }) => {
        adopted = reporter;
        return true;
      }),
    };
    const after = createPrEnvironmentService({
      store: createPrEnvironmentStore(c.db),
      probePreviewConfig: async () => 'present',
      findProject: (id) => (id === project.id ? project : null),
      getRuntime: () => runtime,
      readPrState: async () => {
        throw new Error('hosted repo unavailable');
      },
      log: () => {},
    });
    expect(await after.recoverPending()).toMatchObject({ reattached: 1, interrupted: 0 });
    expect(runtime.reattach).toHaveBeenCalledWith(
      expect.objectContaining({ env: expect.objectContaining({ runnerRef: 'runner-A' }) }),
    );
    expect(after.get('p1', PR)).toMatchObject({ status: 'ready' });
    expect(adopted).not.toBeNull();
    expect(await after.recoverPending()).toMatchObject({ reattached: 0 });
  });

  it('a ready environment the runtime no longer has is failed and torn down', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    c.reporters[0].ready('http://10.0.0.1:32000');
    const runtime: PrEnvironmentRuntime = {
      build: vi.fn(),
      teardown: vi.fn(),
      reattach: vi.fn(() => false),
    };
    const after = restart(c.db, runtime);
    expect(await after.recoverPending()).toMatchObject({ interrupted: 1 });
    expect(after.get('p1', PR)).toMatchObject({
      status: 'failed',
      url: null,
      cleanupPending: false,
    });
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
    expect(runtime.build).not.toHaveBeenCalled();
  });

  it('a runner loss with requeue tears down the old runner and rebuilds the same head', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    c.reporters[0].ready('http://10.0.0.1:32000');
    c.reporters[0].lost('runner lost', { requeue: true });
    for (let i = 0; i < 5; i++) await flush();
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(1);
    expect(vi.mocked(c.runtime!.teardown).mock.calls[0][0].env).toMatchObject({
      runnerRef: 'runner-A',
    });
    expect(c.runtime!.build).toHaveBeenCalledTimes(2);
    expect(c.service.get('p1', PR)).toMatchObject({
      status: 'queued',
      headSha: SHA_A,
      error: 'runner lost',
      cleanupPending: false,
    });
    // The lost generation's reporter is dead.
    c.reporters[0].ready('http://stale');
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'queued' });
    c.reporters[1].ready('http://10.0.0.2:32001');
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'ready', error: null });
  });

  it('a runner loss without requeue leaves the environment failed', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    c.reporters[0].lost('lost three times', { requeue: false });
    for (let i = 0; i < 5; i++) await flush();
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'failed', error: 'lost three times' });
    expect(c.runtime!.teardown).toHaveBeenCalledTimes(1);
    expect(c.runtime!.build).toHaveBeenCalledTimes(1);
  });

  it('builds dispatched in this process are not treated as interrupted', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    await flush();
    c.reporters[0].building('runner-A');
    expect(await c.service.recoverPending()).toMatchObject({ interrupted: 0 });
    expect(c.service.get('p1', PR)).toMatchObject({ status: 'building' });
  });
});

describe('org switch while an operation is in flight', () => {
  function twoOrgs() {
    const dbA = new Database(':memory:');
    const dbB = new Database(':memory:');
    dbA.exec(PR_ENVIRONMENTS_SCHEMA);
    dbB.exec(PR_ENVIRONMENTS_SCHEMA);
    let currentDb = dbA;
    const reporters: PrEnvironmentReporter[] = [];
    const runtime = {
      build: vi.fn(({ reporter }: { reporter: PrEnvironmentReporter }) => {
        reporters.push(reporter);
      }),
      teardown: vi.fn(),
    };
    let releaseProbe: (v: 'present') => void = () => {};
    const probe = vi.fn(
      () => new Promise<'present' | 'absent' | 'unresolved'>((r) => (releaseProbe = r)),
    );
    // Each org has its own project object for the same id, like two tenants
    // that both have a project called p1.
    const projectA = { ...project, name: 'org A' } as Project;
    const projectB = { ...project, name: 'org B' } as Project;
    const projectOf = new Map<unknown, Project>([
      [dbA, projectA],
      [dbB, projectB],
    ]);
    const service = createOrgScopedPrEnvironmentService({
      currentOrg: () => {
        const db = currentDb;
        return {
          key: db,
          db,
          stmts: null,
          findProject: (id: string) => (id === project.id ? projectOf.get(db)! : null),
        };
      },
      create: (org) =>
        createPrEnvironmentService({
          store: createPrEnvironmentStore(org.db),
          probePreviewConfig: probe,
          findProject: org.findProject,
          getRuntime: () => runtime,
          log: () => {},
        }),
    });
    const rows = (db: InstanceType<typeof Database>) =>
      db.prepare('SELECT project_id, pr_number, status, head_sha FROM pr_environments').all();
    return {
      dbA,
      dbB,
      projectA,
      projectB,
      service,
      runtime,
      reporters,
      rows,
      switchTo: (db: InstanceType<typeof Database>) => (currentDb = db),
      /** Let the queued operation reach its probe, then resolve it. */
      release: async () => {
        await flush();
        releaseProbe('present');
      },
    };
  }

  it('a start whose config probe resolves after a switch writes to the org it started in', async () => {
    const o = twoOrgs();
    const starting = o.service.start(project, PR, openAt(SHA_A));
    await flush();
    o.switchTo(o.dbB);
    await o.release();
    expect(await starting).toMatchObject({ ok: true, environment: { status: 'queued' } });
    expect(o.rows(o.dbA)).toEqual([
      { project_id: 'p1', pr_number: 7, status: 'queued', head_sha: SHA_A },
    ]);
    expect(o.rows(o.dbB)).toEqual([]);
  });

  it('a PR-open event pending across a switch does not touch an overlapping row in the other org', async () => {
    const o = twoOrgs();
    const SHA_C = 'c'.repeat(40);
    // Org B already has an environment for the same project id and PR number.
    o.switchTo(o.dbB);
    const seedingB = o.service.start(project, PR, openAt(SHA_B));
    await o.release();
    await seedingB;
    // So does org A, which then gets a push.
    o.switchTo(o.dbA);
    const seedingA = o.service.start(project, PR, openAt(SHA_A));
    await o.release();
    await seedingA;

    const opening = o.service.onPrOpened(project, { ...PR, headSha: SHA_C, headBranch: null });
    await flush();
    o.switchTo(o.dbB);
    await o.release();
    await opening;

    expect(o.rows(o.dbA)).toEqual([
      { project_id: 'p1', pr_number: 7, status: 'queued', head_sha: SHA_C },
    ]);
    expect(o.rows(o.dbB)).toEqual([
      { project_id: 'p1', pr_number: 7, status: 'queued', head_sha: SHA_B },
    ]);
  });

  it("a build's progress reports land in its own org after a switch", async () => {
    const o = twoOrgs();
    const opening = o.service.start(project, PR, openAt(SHA_A));
    await o.release();
    await opening;
    await flush();
    o.switchTo(o.dbB);
    o.reporters[0].ready('http://pr-7.org-a');
    expect(o.rows(o.dbA)).toEqual([
      { project_id: 'p1', pr_number: 7, status: 'ready', head_sha: SHA_A },
    ]);
    expect(o.rows(o.dbB)).toEqual([]);
    // Reads follow the active org.
    expect(o.service.get('p1', PR)).toBeNull();
    o.switchTo(o.dbA);
    expect(o.service.get('p1', PR)).toMatchObject({ status: 'ready' });
  });

  it('recovery covers every org this process has touched, not only the active one', async () => {
    const o = twoOrgs();
    const opening = o.service.start(project, PR, openAt(SHA_A));
    await o.release();
    await opening;
    // Org A's env is stopped while its teardown fails, then the user switches.
    o.runtime.teardown.mockRejectedValueOnce(new Error('daemon down'));
    await o.service.stop(project, PR);
    o.switchTo(o.dbB);
    expect(await o.service.recoverPending()).toMatchObject({ tornDown: 1 });
    expect(o.runtime.teardown).toHaveBeenCalledTimes(2);
  });

  it("recovery of an inactive org's teardown uses that org's project, not the active org's", async () => {
    const o = twoOrgs();
    const opening = o.service.start(o.projectA, PR, openAt(SHA_A));
    await o.release();
    await opening;
    o.runtime.teardown.mockRejectedValueOnce(new Error('daemon down'));
    await o.service.stop(o.projectA, PR);

    o.switchTo(o.dbB); // org B also has a project "p1"
    await o.service.recoverPending();
    const retried = o.runtime.teardown.mock.calls[1][0];
    expect(retried.project).toBe(o.projectA);
    expect(retried.project).not.toBe(o.projectB);
  });

  it('pin() captures one org for a whole operation; reads through the pinned service stay there', async () => {
    const o = twoOrgs();
    const pinnedA = o.service.pin();
    const opening = pinnedA.start(o.projectA, PR, openAt(SHA_A));
    o.switchTo(o.dbB);
    await o.release();
    await opening;
    expect(pinnedA.org.db).toBe(o.dbA);
    expect(pinnedA.get('p1', PR)).toMatchObject({ headSha: SHA_A });
    expect(o.service.get('p1', PR)).toBeNull(); // the facade follows the active org
  });
});

describe('prEnvironmentPanelVisible', () => {
  const env = (over: Record<string, unknown> = {}) => ({
    status: 'stopped' as const,
    cleanupPending: false,
    ...over,
  });

  it('shows on an open PR whose head declares preview', () => {
    expect(prEnvironmentPanelVisible(null, true)).toBe(true);
    expect(prEnvironmentPanelVisible(env(), true)).toBe(true);
  });

  it('keeps an env that still needs attention visible, even without a block or on a closed PR', () => {
    for (const prOpen of [true, false]) {
      expect(prEnvironmentPanelVisible(env({ cleanupPending: true }), false, prOpen)).toBe(true);
      for (const status of ['queued', 'building', 'ready', 'failed'] as const) {
        expect(prEnvironmentPanelVisible(env({ status }), false, prOpen)).toBe(true);
      }
    }
  });

  it('hides a fully stopped env when the head has no block or the PR is closed', () => {
    expect(prEnvironmentPanelVisible(env(), false)).toBe(false);
    expect(prEnvironmentPanelVisible(env(), true, false)).toBe(false);
    expect(prEnvironmentPanelVisible(null, false)).toBe(false);
    expect(prEnvironmentPanelVisible(null, true, false)).toBe(false);
  });
});

describe('catch-up covers every trigger', () => {
  it('an org first used after the runtime registered recovers its pending teardown and queued build', async () => {
    const dbA = new Database(':memory:');
    const dbB = new Database(':memory:');
    dbA.exec(PR_ENVIRONMENTS_SCHEMA);
    dbB.exec(PR_ENVIRONMENTS_SCHEMA);
    // Before the restart, org B had a pending teardown (PR 7) and a queued
    // build (PR 8), both left while no runtime was available.
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(dbB),
      probePreviewConfig: async () => 'present',
      getRuntime: () => null,
      log: () => {},
    });
    await before.start(project, PR, openAt(SHA_A));
    await before.onPrClosed(project, { ...PR, merged: true });
    await before.start(project, { source: 'native', prNumber: 8 }, openAt(SHA_B));

    const runtime = { build: vi.fn(), teardown: vi.fn() };
    let current = dbA;
    const service = createOrgScopedPrEnvironmentService({
      currentOrg: () => ({ key: current, db: current, stmts: null, findProject: () => project }),
      create: (org) =>
        createPrEnvironmentService({
          store: createPrEnvironmentStore(org.db),
          probePreviewConfig: async () => 'present',
          findProject: org.findProject,
          getRuntime: () => runtime,
          log: () => {},
        }),
    });
    // Runtime registers while org A is active: B is not known yet.
    await service.catchUp();
    expect(runtime.teardown).not.toHaveBeenCalled();

    // Org B is used for the first time: it catches up on its own.
    current = dbB;
    service.get('p1', PR);
    await vi.waitFor(() => expect(runtime.teardown).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(runtime.build).toHaveBeenCalledTimes(1));
    expect(service.get('p1', PR)).toMatchObject({ status: 'stopped', cleanupPending: false });
    expect(runtime.build.mock.calls[0][0].env).toMatchObject({ prNumber: 8, headSha: SHA_B });
  });

  it('a failed teardown retries itself without any user action', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: () => project,
      getRuntime: () => runtime,
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
      },
      log: () => {},
    });
    await svc.start(project, PR, openAt(SHA_A));
    runtime.teardown.mockRejectedValueOnce(new Error('docker daemon down'));
    await svc.onPrClosed(project, { ...PR, merged: true });
    expect(svc.get('p1', PR)).toMatchObject({ cleanupPending: true });
    const retry = timers.find((t) => t.ms === PR_TEARDOWN_RETRY_MS)!;
    expect(retry).toBeDefined();

    retry.fn();
    await vi.waitFor(() => expect(svc.get('p1', PR)).toMatchObject({ cleanupPending: false }));
    expect(runtime.teardown).toHaveBeenCalledTimes(2);
  });
});

describe('catch-up re-checks environments against their PRs after a restart', () => {
  it('a closed PR with a stale queued row and a merged PR with a ready row are stopped, not rebuilt', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const SHA_C = 'c'.repeat(40);
    // Before the restart: PR 7 queued (no runtime yet), PR 8 ready, PR 9 ready
    // at A. Then the Hub went down right after PR 7 closed, PR 8 merged, and
    // PR 9 got a push to C, before their environment updates ran.
    const runtime1 = { build: vi.fn(), teardown: vi.fn() };
    let reporters: PrEnvironmentReporter[] = [];
    runtime1.build.mockImplementation(({ reporter }: { reporter: PrEnvironmentReporter }) => {
      reporters.push(reporter);
    });
    let runtimeBefore: PrEnvironmentRuntime | null = null;
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => runtimeBefore,
      log: () => {},
    });
    const n = (prNumber: number) => ({ source: 'native' as const, prNumber });
    await before.start(project, n(7), openAt(SHA_A));
    runtimeBefore = runtime1;
    await before.start(project, n(8), openAt(SHA_A));
    await before.start(project, n(9), openAt(SHA_A));
    await flush();
    reporters.forEach((r) => r.ready('http://pr.local'));
    expect(before.get('p1', n(7))).toMatchObject({ status: 'queued' });
    expect(before.get('p1', n(8))).toMatchObject({ status: 'ready' });

    // After the restart: the PR rows are the truth.
    const prs = new Map<number, PrAuthoritativeState>([
      [7, { status: 'closed' }],
      [8, { status: 'merged' }],
      [9, { status: 'open', headSha: SHA_C, headBranch: null }],
    ]);
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    reporters = [];
    const after = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: () => project,
      readPrState: async (_p, pr) => prs.get(pr.prNumber) ?? null,
      getRuntime: () => runtime,
      log: () => {},
    });
    await after.catchUp();
    await flush();

    expect(after.get('p1', n(7))).toMatchObject({ status: 'stopped', stopReason: 'closed' });
    expect(after.get('p1', n(8))).toMatchObject({
      status: 'stopped',
      stopReason: 'merged',
      cleanupPending: false,
    });
    expect(after.get('p1', n(9))).toMatchObject({ status: 'queued', headSha: SHA_C });
    // Only PR 9 builds (at its new head); the closed PR's queued row is not.
    expect(runtime.build.mock.calls.map((c) => [c[0].env.prNumber, c[0].env.headSha])).toEqual([
      [9, SHA_C],
    ]);
    // The merged PR's ready stack and PR 9's old stack are torn down.
    const tornDown = runtime.teardown.mock.calls.map((c) => c[0].env.prNumber).sort();
    expect(tornDown).toEqual([7, 8, 9]);
  });

  it('reconcile without an explicit reader uses readPrState', async () => {
    const c = setup();
    await c.service.start(project, PR, openAt(SHA_A));
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(c.db),
      probePreviewConfig: async () => 'present',
      readPrState: async () => ({ status: 'closed' }),
      getRuntime: () => null,
      log: () => {},
    });
    expect(await svc.reconcile(project, PR)).toMatchObject({
      status: 'stopped',
      stopReason: 'closed',
    });
  });
});

describe('catch-up finds PRs whose environment events were lost entirely', () => {
  function restartWith(db: InstanceType<typeof Database>, prs: Map<number, PrAuthoritativeState>) {
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: () => project,
      readPrState: async (_p, pr) => prs.get(pr.prNumber) ?? null,
      listOpenPrs: () =>
        [...prs.entries()]
          .filter(([, st]) => st?.status === 'open')
          .map(([prNumber]) => ({ projectId: 'p1', prNumber })),
      getRuntime: () => runtime,
      log: () => {},
    });
    return { svc, runtime };
  }
  const n = (prNumber: number) => ({ source: 'native' as const, prNumber });

  it('an open PR with no environment row is left alone: environments are opt-in', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const { svc, runtime } = restartWith(
      db,
      new Map([[11, { status: 'open', headSha: SHA_A, headBranch: 'fix/new' }]]),
    );
    expect(svc.get('p1', n(11))).toBeNull();
    await svc.catchUp();
    await flush();
    expect(svc.get('p1', n(11))).toBeNull();
    expect(runtime.build).not.toHaveBeenCalled();
  });

  it('an open PR whose environment exists is moved to its new head on catch-up', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => ({ build: vi.fn(), teardown: vi.fn() }),
      log: () => {},
    });
    await before.start(project, n(11), openAt(SHA_A, 'fix/new'));

    const { svc, runtime } = restartWith(
      db,
      new Map([[11, { status: 'open', headSha: SHA_B, headBranch: 'fix/new' }]]),
    );
    await svc.catchUp();
    await flush();
    expect(svc.get('p1', n(11))).toMatchObject({ status: 'queued', headSha: SHA_B });
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a fully stopped environment whose PR was reopened just before the restart is rebuilt', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => ({ build: vi.fn(), teardown: vi.fn() }),
      log: () => {},
    });
    await before.start(project, n(12), openAt(SHA_A));
    await before.onPrClosed(project, { ...n(12), merged: false });
    expect(before.get('p1', n(12))).toMatchObject({ status: 'stopped', cleanupPending: false });

    const { svc, runtime } = restartWith(
      db,
      new Map([[12, { status: 'open', headSha: SHA_A, headBranch: null }]]),
    );
    await svc.catchUp();
    await flush();
    expect(svc.get('p1', n(12))).toMatchObject({ status: 'queued', stopReason: null });
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a manual stop survives: an open PR does not restart it on catch-up', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => ({ build: vi.fn(), teardown: vi.fn() }),
      log: () => {},
    });
    await before.start(project, n(13), openAt(SHA_A));
    await before.stop(project, n(13));

    const { svc, runtime } = restartWith(
      db,
      new Map([[13, { status: 'open', headSha: SHA_B, headBranch: null }]]),
    );
    await svc.catchUp();
    await flush();
    expect(svc.get('p1', n(13))).toMatchObject({
      status: 'stopped',
      stopReason: 'manual',
      headSha: SHA_B, // head tracked for the next Start
    });
    expect(runtime.build).not.toHaveBeenCalled();
  });
});

describe('the PR is re-checked after every await before anything is built', () => {
  const n = { source: 'native' as const, prNumber: 21 };
  function harness() {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    let pr: PrAuthoritativeState = { status: 'open', headSha: SHA_A, headBranch: 'fix/x' };
    let releaseProbe: (v: 'present') => void = () => {};
    const probe = vi.fn(
      () => new Promise<'present' | 'absent' | 'unresolved'>((r) => (releaseProbe = r)),
    );
    const runtime = { build: vi.fn(), teardown: vi.fn() };
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: probe,
      findProject: () => project,
      readPrState: async () => pr,
      getRuntime: () => runtime,
      log: () => {},
    });
    /** Let the operation reach its probe, then resolve it. */
    const release = async () => {
      await flush();
      releaseProbe('present');
    };
    return {
      svc,
      runtime,
      probe,
      setPr: (next: PrAuthoritativeState) => (pr = next),
      /** Manually start an environment at the PR's current head. */
      startNow: async () => {
        const starting = svc.start(project, n, async () => pr);
        await release();
        const res = await starting;
        await flush();
        return res;
      },
      release,
    };
  }

  for (const merged of [false, true]) {
    it(`a ${merged ? 'merge' : 'close'} during the config probe: reconcile builds nothing and the PR ends stopped`, async () => {
      const h = harness();
      // An env is running at A; a push to B starts reconciling.
      expect(await h.startNow()).toMatchObject({ ok: true });
      expect(h.runtime.build).toHaveBeenCalledTimes(1);
      h.setPr({ status: 'open', headSha: SHA_B, headBranch: 'fix/x' });
      const syncing = h.svc.reconcile(project, n);
      await flush();
      expect(h.probe).toHaveBeenCalledTimes(2);
      // The PR row changes while the probe is pending; its own reconcile queues.
      h.setPr({ status: merged ? 'merged' : 'closed' });
      const closing = h.svc.reconcile(project, n);
      await h.release();
      await syncing;
      const final = await closing;
      await flush();
      expect(h.runtime.build).toHaveBeenCalledTimes(1); // B was never built
      expect(final).toMatchObject({ status: 'stopped' });
    });
  }

  it('manual start: a close during the config probe is refused, not reported as started', async () => {
    const h = harness();
    let pr: PrAuthoritativeState = { status: 'open', headSha: SHA_A, headBranch: 'fix/x' };
    const starting = h.svc.start(project, n, async () => pr);
    await flush();
    pr = { status: 'closed' };
    await h.release();
    const res = await starting;
    await flush();
    expect(res).toMatchObject({ ok: false, reason: 'not_open' });
    expect(h.runtime.build).not.toHaveBeenCalled();
  });

  it('a push during the config probe re-checks the new head instead of building the old one', async () => {
    const h = harness();
    const SHA_C = 'c'.repeat(40);
    await h.startNow(); // env at A
    h.setPr({ status: 'open', headSha: SHA_B, headBranch: 'fix/x' });
    const syncing = h.svc.reconcile(project, n);
    await flush();
    h.setPr({ status: 'open', headSha: SHA_C, headBranch: 'fix/x' });
    await h.release(); // probe for B resolves; the PR is now at C
    await h.release(); // probe for C resolves
    const env = await syncing;
    await flush();
    expect(env).toMatchObject({ status: 'queued', headSha: SHA_C });
    expect(h.runtime.build.mock.calls.map((c) => c[0].env.headSha)).toEqual([SHA_A, SHA_C]);
  });

  it('a close during a slow teardown blocks the dispatch that would follow it', async () => {
    const h = harness();
    // An env is running at A.
    await h.startNow();
    expect(h.runtime.build).toHaveBeenCalledTimes(1);

    // A push to B: the old stack's teardown is slow, and the PR closes meanwhile.
    let finishTeardown!: () => void;
    h.runtime.teardown.mockImplementationOnce(() => new Promise<void>((r) => (finishTeardown = r)));
    h.setPr({ status: 'open', headSha: SHA_B, headBranch: 'fix/x' });
    const pushing = h.svc.reconcile(project, n);
    await h.release();
    await vi.waitFor(() => expect(finishTeardown).toBeTypeOf('function'));
    h.setPr({ status: 'closed' });
    finishTeardown();
    await pushing;
    await flush();
    expect(h.runtime.build).toHaveBeenCalledTimes(1); // B was never dispatched

    // Recovery must not dispatch the rejected build either, whichever way it runs.
    await h.svc.recoverPending();
    await h.svc.catchUp();
    await flush();
    expect(h.runtime.build).toHaveBeenCalledTimes(1);
  });

  it('recovery dispatches nothing when the PR state cannot be read', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    // A queued row left from before (no runtime then).
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => null,
      log: () => {},
    });
    await before.start(project, n, openAt(SHA_A));

    const runtime = { build: vi.fn(), teardown: vi.fn() };
    let fail = true;
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: () => project,
      readPrState: async () => {
        if (fail) throw new Error('database is locked');
        return { status: 'open', headSha: SHA_A, headBranch: null };
      },
      getRuntime: () => runtime,
      log: () => {},
    });
    await svc.catchUp();
    await svc.recoverPending();
    await flush();
    expect(runtime.build).not.toHaveBeenCalled();
    expect(svc.get('p1', n)).toMatchObject({ status: 'queued' });

    // Once the PR can be read (and still wants it), the next catch-up builds.
    fail = false;
    await svc.catchUp();
    await flush();
    expect(runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a build interrupted by a restart is not adopted for a PR that no longer wants it', async () => {
    const db = new Database(':memory:');
    db.exec(PR_ENVIRONMENTS_SCHEMA);
    const reporters: PrEnvironmentReporter[] = [];
    const before = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      getRuntime: () => ({
        build: ({ reporter }) => {
          reporters.push(reporter);
        },
        teardown: vi.fn(),
      }),
      log: () => {},
    });
    await before.start(project, n, openAt(SHA_A));
    await flush();
    reporters[0].building('runner-A');

    const reattach = vi.fn(() => true);
    const runtime: PrEnvironmentRuntime = { build: vi.fn(), teardown: vi.fn(), reattach };
    const svc = createPrEnvironmentService({
      store: createPrEnvironmentStore(db),
      probePreviewConfig: async () => 'present',
      findProject: () => project,
      // The PR moved to B. recoverPending runs no reconcile, so only the
      // adoption-time check stands between the obsolete build and the runtime.
      readPrState: async () => ({ status: 'open', headSha: SHA_B, headBranch: null }),
      getRuntime: () => runtime,
      log: () => {},
    });
    expect(await svc.recoverPending()).toMatchObject({ reattached: 0, interrupted: 1 });
    expect(reattach).not.toHaveBeenCalled();
    expect(runtime.teardown).toHaveBeenCalledTimes(1);
  });
});
