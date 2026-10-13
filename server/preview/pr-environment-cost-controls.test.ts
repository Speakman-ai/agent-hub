/**
 * PR environment cost controls through the real service and store: cap
 * eviction on dispatch, the idle/expiry sweep, request hits, and waking a
 * sleeping environment. The runtime is a mock that records builds.
 */
import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  PR_ENVIRONMENTS_SCHEMA,
  migratePrEnvironmentsUsageColumns,
} from './pr-environments-schema.js';
import {
  PR_ENVIRONMENT_HIT_THROTTLE_MS,
  createPrEnvironmentService,
  createPrEnvironmentStore,
  type PrAuthoritativeState,
  type PrEnvironmentReporter,
} from './pr-environments.js';
import type { Project } from '../types.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const sha = (c: string) => c.repeat(40);
const flush = () => new Promise((r) => setTimeout(r, 0));

function setup(
  limits: Project['prEnvironmentLimits'] = {},
  opts: { wakeOnRequest?: boolean } = {},
) {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENTS_SCHEMA);
  const project = { id: 'p1', prEnvironmentLimits: limits } as Project;
  const builds: Array<{ prNumber: number; headSha: string; reporter: PrEnvironmentReporter }> = [];
  const runtime = {
    build: vi.fn(
      ({
        env,
        reporter,
      }: {
        env: { prNumber: number; headSha: string };
        reporter: PrEnvironmentReporter;
      }) => {
        builds.push({ prNumber: env.prNumber, headSha: env.headSha, reporter });
      },
    ),
    teardown: vi.fn(),
  };
  const clock = { now: 10 * DAY };
  // PR state: open at a head, per PR number.
  const prs = new Map<number, PrAuthoritativeState>();
  // Set `gate.wait` to hold PR-state reads (and so the per-PR queue): every
  // PR's, or only `gate.only`'s.
  const gate: { wait: Promise<void> | null; only?: number } = { wait: null };
  const service = createPrEnvironmentService({
    store: createPrEnvironmentStore(db),
    probePreviewConfig: async () => 'present',
    findProject: (id) => (id === project.id ? project : null),
    readPrState: async (_p, pr) => {
      if (gate.wait && (gate.only == null || gate.only === pr.prNumber)) await gate.wait;
      return prs.get(pr.prNumber) ?? null;
    },
    getRuntime: () => runtime,
    wakeOnRequest: () => opts.wakeOnRequest ?? true,
    now: () => clock.now,
    log: () => {},
  });
  const pr = (n: number) => ({ source: 'native' as const, prNumber: n });

  /** Open PR `n` at `head` and bring its environment to ready. */
  async function ready(n: number, head = sha('a')) {
    prs.set(n, { status: 'open', headSha: head, headBranch: `b${n}` });
    await service.onPrOpened(project, { ...pr(n), headSha: head, headBranch: `b${n}` });
    await flush();
    const b = builds.filter((x) => x.prNumber === n).at(-1)!;
    b.reporter.building();
    b.reporter.ready(`http://127.0.0.1:${4000 + n}`);
  }
  return { db, project, service, runtime, builds, clock, prs, pr, ready, gate };
}

describe('cap: eviction order on dispatch', () => {
  it('starting one more env puts the least recently used ready env to sleep', async () => {
    const t = setup({ maxConcurrent: 2 });
    await t.ready(1);
    t.clock.now += MIN;
    await t.ready(2);
    t.clock.now += MIN;
    // PR 1 is older but was requested recently; PR 2 has never been hit.
    t.service.recordHit('p1', t.pr(1));
    t.clock.now += MIN;

    await t.ready(3);
    await flush();
    expect(t.service.get('p1', t.pr(2))).toMatchObject({ status: 'stopped', stopReason: 'idle' });
    expect(t.service.get('p1', t.pr(1))?.status).toBe('ready');
    expect(t.service.get('p1', t.pr(3))?.status).toBe('ready');
    expect(t.runtime.teardown).toHaveBeenCalledTimes(1);
  });

  it('no cap (0) evicts nothing', async () => {
    const t = setup({ maxConcurrent: 0 });
    for (const n of [1, 2, 3, 4, 5, 6]) await t.ready(n);
    await flush();
    expect(t.service.list('p1').every((e) => e.status === 'ready')).toBe(true);
  });
});

describe('sweep: idle TTL and max lifetime', () => {
  it('puts an env with no requests past the idle TTL to sleep; a recent hit keeps it up', async () => {
    const t = setup({ idleTtlMinutes: 30 });
    await t.ready(1);
    await t.ready(2);
    t.clock.now += 25 * MIN;
    t.service.recordHit('p1', t.pr(2));
    t.clock.now += 10 * MIN;
    expect(await t.service.enforceLimits()).toEqual({ slept: 1, expired: 0 });
    expect(t.service.get('p1', t.pr(1))).toMatchObject({ status: 'stopped', stopReason: 'idle' });
    expect(t.service.get('p1', t.pr(2))?.status).toBe('ready');
  });

  it('expires an env whose head has not moved past the max lifetime; a push renews it', async () => {
    const t = setup({ maxLifetimeDays: 3, idleTtlMinutes: 0 });
    await t.ready(1);
    t.clock.now += 2 * DAY;
    await t.ready(1, sha('b')); // push: rebuild at a new head
    t.clock.now += 2 * DAY;
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 0 });
    t.clock.now += 2 * DAY;
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 1 });
    expect(t.service.get('p1', t.pr(1))).toMatchObject({
      status: 'stopped',
      stopReason: 'expired',
    });
  });

  it('catch-up does not rebuild a sleeping env for its open PR', async () => {
    const t = setup({ idleTtlMinutes: 30 });
    await t.ready(1);
    t.clock.now += 31 * MIN;
    await t.service.enforceLimits();
    const before = t.runtime.build.mock.calls.length;
    await t.service.reconcile(t.project, t.pr(1));
    await flush();
    expect(t.runtime.build.mock.calls.length).toBe(before);
    expect(t.service.get('p1', t.pr(1))?.stopReason).toBe('idle');
  });
});

describe('hits', () => {
  it('records at most one hit per throttle window', async () => {
    const t = setup();
    await t.ready(1);
    t.service.recordHit('p1', t.pr(1));
    const first = t.service.get('p1', t.pr(1))!.lastHitAt;
    t.clock.now += PR_ENVIRONMENT_HIT_THROTTLE_MS - 1;
    t.service.recordHit('p1', t.pr(1));
    expect(t.service.get('p1', t.pr(1))!.lastHitAt).toBe(first);
    t.clock.now += 1;
    t.service.recordHit('p1', t.pr(1));
    expect(t.service.get('p1', t.pr(1))!.lastHitAt).not.toBe(first);
  });
});

describe('wake', () => {
  it('rebuilds a sleeping env at the PR’s current head and it becomes ready', async () => {
    const t = setup({ idleTtlMinutes: 30 });
    await t.ready(1);
    t.clock.now += 31 * MIN;
    await t.service.enforceLimits();
    // A push landed while it slept.
    t.prs.set(1, { status: 'open', headSha: sha('c'), headBranch: 'b1' });

    expect(await t.service.wake(t.project, t.pr(1))).toBe('waking');
    await flush();
    expect(t.service.get('p1', t.pr(1))).toMatchObject({ status: 'queued', headSha: sha('c') });
    const b = t.builds.at(-1)!;
    expect(b.headSha).toBe(sha('c'));
    b.reporter.ready('http://127.0.0.1:4999');
    expect(t.service.get('p1', t.pr(1))).toMatchObject({ status: 'ready', stopReason: null });
    // Waking again is a no-op.
    expect(await t.service.wake(t.project, t.pr(1))).toBe('not_sleeping');
  });

  it('waking respects the cap: it puts the least recently used env to sleep', async () => {
    const t = setup({ maxConcurrent: 1 });
    await t.ready(1);
    await t.ready(2); // evicts PR 1
    await flush();
    expect(t.service.get('p1', t.pr(1))?.stopReason).toBe('idle');
    expect(await t.service.wake(t.project, t.pr(1))).toBe('waking');
    await flush();
    expect(t.service.get('p1', t.pr(2))).toMatchObject({ status: 'stopped', stopReason: 'idle' });
    expect(t.service.get('p1', t.pr(1))?.status).toBe('queued');
  });

  it('refuses to wake an env that went stale and marks it expired', async () => {
    const t = setup({ idleTtlMinutes: 30, maxLifetimeDays: 2 });
    await t.ready(1);
    t.clock.now += 31 * MIN;
    await t.service.enforceLimits();
    t.clock.now += 2 * DAY;
    expect(await t.service.wake(t.project, t.pr(1))).toBe('expired');
    expect(t.service.get('p1', t.pr(1))?.stopReason).toBe('expired');
  });

  it('a closed PR is stopped as closed instead of woken', async () => {
    const t = setup({ idleTtlMinutes: 30 });
    await t.ready(1);
    t.clock.now += 31 * MIN;
    await t.service.enforceLimits();
    t.prs.set(1, { status: 'closed' });
    expect(await t.service.wake(t.project, t.pr(1))).toBe('not_sleeping');
    expect(t.service.get('p1', t.pr(1))?.stopReason).toBe('closed');
  });

  it('a manual start of an expired env renews its lifetime', async () => {
    const t = setup({ maxLifetimeDays: 2, idleTtlMinutes: 0 });
    await t.ready(1);
    t.clock.now += 3 * DAY;
    await t.service.enforceLimits();
    expect(t.service.get('p1', t.pr(1))?.stopReason).toBe('expired');
    const res = await t.service.start(t.project, t.pr(1), async () => t.prs.get(1)!);
    expect(res.ok).toBe(true);
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 0 });
    expect(t.service.get('p1', t.pr(1))?.status).toBe('queued');
  });
});

describe('migratePrEnvironmentsUsageColumns', () => {
  it('adds the columns to an older table and starts lifetimes at the last update', () => {
    const db = new Database(':memory:');
    db.exec(
      PR_ENVIRONMENTS_SCHEMA.replace(/\s+last_hit_at\s+INTEGER,/, '').replace(
        /\s+renewed_at\s+INTEGER,/,
        '',
      ),
    );
    db.prepare(
      `INSERT INTO pr_environments (id, project_id, source, pr_number, head_sha, status, created_at, updated_at)
       VALUES ('e1', 'p1', 'native', 1, 'x', 'ready', 1, 500)`,
    ).run();
    migratePrEnvironmentsUsageColumns(db);
    migratePrEnvironmentsUsageColumns(db);
    expect(db.prepare('SELECT last_hit_at, renewed_at FROM pr_environments').get()).toEqual({
      last_hit_at: null,
      renewed_at: 500,
    });
  });
});

const live = (t: ReturnType<typeof setup>) =>
  t.service.list('p1').filter((e) => ['queued', 'building', 'ready'].includes(e.status));

function hold(t: ReturnType<typeof setup>, only?: number) {
  let release!: () => void;
  t.gate.only = only;
  t.gate.wait = new Promise<void>((r) => (release = r));
  return () => {
    t.gate.wait = null;
    release();
  };
}

describe('concurrent admissions', () => {
  it('two PRs starting at once under a cap of 1 do not evict each other', async () => {
    const t = setup({ maxConcurrent: 1 });
    t.prs.set(1, { status: 'open', headSha: sha('a'), headBranch: 'b1' });
    t.prs.set(2, { status: 'open', headSha: sha('a'), headBranch: 'b2' });
    await Promise.all([
      t.service.onPrOpened(t.project, { ...t.pr(1), headSha: sha('a'), headBranch: 'b1' }),
      t.service.onPrOpened(t.project, { ...t.pr(2), headSha: sha('a'), headBranch: 'b2' }),
    ]);
    await flush();
    await flush();
    expect(live(t)).toHaveLength(1);
    expect(t.runtime.build).toHaveBeenCalledTimes(1);
  });

  it('a wake racing a new start leaves exactly one env running', async () => {
    const t = setup({ maxConcurrent: 1 });
    await t.ready(1);
    await t.ready(2); // puts PR 1 to sleep
    await flush();
    t.prs.set(3, { status: 'open', headSha: sha('a'), headBranch: 'b3' });
    await Promise.all([
      t.service.wake(t.project, t.pr(1)),
      t.service.onPrOpened(t.project, { ...t.pr(3), headSha: sha('a'), headBranch: 'b3' }),
    ]);
    await flush();
    await flush();
    expect(live(t)).toHaveLength(1);
  });
});

describe('without wildcard ingress (direct upstream URLs)', () => {
  it('does not put idle environments to sleep, since nothing could wake them', async () => {
    const t = setup({ idleTtlMinutes: 30 }, { wakeOnRequest: false });
    await t.ready(1);
    t.clock.now += 10 * 60 * MIN;
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 0 });
    expect(t.service.get('p1', t.pr(1))?.status).toBe('ready');
  });

  it('still enforces the cap and the max lifetime', async () => {
    const t = setup({ maxConcurrent: 1, maxLifetimeDays: 2 }, { wakeOnRequest: false });
    await t.ready(1);
    await t.ready(2);
    await flush();
    expect(t.service.get('p1', t.pr(1))?.status).toBe('stopped');
    t.clock.now += 3 * DAY;
    // The running one and the one asleep since the eviction.
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 2 });
  });
});

describe('cost stops are decided and applied in one step', () => {
  it('a victim whose queue is busy with a push is stopped at once and stays asleep at the new head', async () => {
    const t = setup({ maxConcurrent: 1 });
    await t.ready(1);
    t.prs.set(1, { status: 'open', headSha: sha('b'), headBranch: 'b1' });
    const release = hold(t, 1);
    const busy = t.service.reconcile(t.project, t.pr(1)); // will pick up the push
    t.prs.set(2, { status: 'open', headSha: sha('a'), headBranch: 'b2' });
    await t.service.onPrOpened(t.project, { ...t.pr(2), headSha: sha('a'), headBranch: 'b2' });
    expect(t.service.get('p1', t.pr(1))).toMatchObject({ status: 'stopped', stopReason: 'idle' });
    release();
    await busy;
    await flush();
    // Not left queued without a build: asleep, tracking the pushed head.
    expect(t.service.get('p1', t.pr(1))).toMatchObject({
      status: 'stopped',
      stopReason: 'idle',
      headSha: sha('b'),
    });
    expect(live(t).map((e) => e.prNumber)).toEqual([2]);
    // Every queued row has its build: PR 2's.
    expect(t.builds.filter((b) => b.prNumber === 2)).toHaveLength(1);
    expect(t.builds.filter((b) => b.prNumber === 1)).toHaveLength(1);
  });

  it('the sweep does not wait on a busy PR queue; a push reconciled after it revives the env', async () => {
    const t = setup({ maxLifetimeDays: 2, idleTtlMinutes: 0 });
    await t.ready(1);
    t.clock.now += 3 * DAY;
    t.prs.set(1, { status: 'open', headSha: sha('b'), headBranch: 'b1' });
    const release = hold(t, 1);
    const busy = t.service.reconcile(t.project, t.pr(1));
    expect(await t.service.enforceLimits()).toEqual({ slept: 0, expired: 1 });
    release();
    await busy;
    // The push renews it and leaves it wakeable at the new head.
    expect(t.service.get('p1', t.pr(1))).toMatchObject({
      status: 'stopped',
      stopReason: 'idle',
      headSha: sha('b'),
    });
    expect(await t.service.wake(t.project, t.pr(1))).toBe('waking');
  });

  it('wake judges expiry after reading the PR: a newer head not yet reconciled renews it', async () => {
    const t = setup({ idleTtlMinutes: 30, maxLifetimeDays: 2 });
    await t.ready(1);
    t.clock.now += 31 * MIN;
    await t.service.enforceLimits();
    t.clock.now += 3 * DAY; // stored lifetime is past the limit
    t.prs.set(1, { status: 'open', headSha: sha('c'), headBranch: 'b1' }); // unreconciled push
    expect(await t.service.wake(t.project, t.pr(1))).toBe('waking');
    await flush();
    expect(t.service.get('p1', t.pr(1))).toMatchObject({ status: 'queued', headSha: sha('c') });
    expect(t.builds.at(-1)!.headSha).toBe(sha('c'));
  });
});
