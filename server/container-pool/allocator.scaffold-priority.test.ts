/**
 * W3: Scaffolding priority tier tests.
 *
 * The demo-day launch pattern is 50 scaffolding jobs (create-next-app
 * style, ~60 s each) arriving within 10 min. This suite pins down the
 * three properties the dispatcher MUST preserve under that load:
 *
 *   1. **Spike simulation** — injecting 50 scaffolds over 10 min must
 *      not regress PR-env p50/p95 dispatch latency vs. a baseline that
 *      has only PR envs.
 *
 *   2. **Fairness** — a PR env that is queued (or arrives between
 *      ticks) always wins the shared overflow slot over any queued
 *      scaffold. Scaffolding never preempts a running PR env, and
 *      never takes overflow if a PR env is waiting.
 *
 *   3. **Capacity** — at most 3 scaffolds run concurrently, except when
 *      the overflow slot is idle AND the PR-env queue is empty (then
 *      up to 4 scaffolds may run — 3 dedicated + 1 overflow).
 *
 * Strategy: deterministic in-memory SQLite + injected clock. Ticks are
 * driven manually between `clock.advance()` steps. Scaffold containers
 * are "released" after a fixed duration by scheduling `release()` calls
 * in the simulator loop — no real timers, no Vitest fake timers, no
 * wall-clock dependence.
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { POOL_SCHEMA } from './schema.js';
import { DEFAULT_CONFIG, PoolAllocator, type Clock } from './allocator.js';

// ─── helpers ──────────────────────────────────────────────────────────────

function makeClock(startMs = Date.parse('2026-04-19T10:00:00Z')): Clock & {
  nowMsRaw(): number;
  advance(ms: number): void;
} {
  let cur = startMs;
  return {
    nowMs: () => cur,
    nowIso: () => new Date(cur).toISOString().slice(0, 19).replace('T', ' '),
    nowMsRaw: () => cur,
    advance(ms) {
      cur += ms;
    },
  };
}

function freshAllocator(config: Partial<typeof DEFAULT_CONFIG> = {}): {
  allocator: PoolAllocator;
  db: Database.Database;
  clock: ReturnType<typeof makeClock>;
} {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(POOL_SCHEMA);
  const clock = makeClock();
  const allocator = new PoolAllocator(db, { config, clock });
  allocator.init();
  return { allocator, db, clock };
}

function busyScaffoldCount(db: Database.Database): number {
  // A scaffold is considered "running concurrently" if any slot is busy
  // and its container_id corresponds to a scaffold queue id. After bind
  // we erase the queue row, so instead we count busy slots whose class
  // is either 'scaffold' or 'overflow' AND whose binding was made for a
  // scaffold. We track this via a test-local map below in the spike
  // simulator; this helper is a fallback for simpler tests.
  const row = db
    .prepare(
      "SELECT COUNT(*) AS n FROM pool_slots WHERE status = 'busy' AND (class = 'scaffold' OR class = 'overflow')",
    )
    .get() as { n: number };
  return row.n;
}

function boundAtSlot(db: Database.Database, slotId: string): string | null {
  const r = db.prepare('SELECT container_id FROM pool_slots WHERE slot_id = ?').get(slotId) as
    | { container_id: string | null }
    | undefined;
  return r?.container_id ?? null;
}

/** Percentile helper — nearest-rank, stable for small samples. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ─── 1. Spike simulation ──────────────────────────────────────────────────

describe('W3 spike simulation — 50 scaffolds in 10 min do not starve PR envs', () => {
  /**
   * Simulator: drives a workload against the allocator in 1 s ticks.
   *
   *   - PR envs arrive on a fixed schedule and stay live for the whole
   *     run (they don't release) — this models the "1–10 concurrent"
   *     steady-state of PR previews.
   *   - Scaffolds arrive on a fixed schedule and release after
   *     `scaffoldDurationMs` (default 60 s).
   *   - Latency is measured as `bind_time_ms - enqueue_time_ms` per
   *     request. We only report PR-env latency here — scaffold latency
   *     is observed but not asserted (the spec allows scaffolds to
   *     wait; it does NOT allow PR envs to wait when a slot is free).
   */
  interface SimInput {
    prSchedule: number[]; // ms offsets from t0 when a PR env enqueues
    scaffoldSchedule: number[]; // ms offsets from t0 when a scaffold enqueues
    scaffoldDurationMs: number;
    runUntilMs: number;
    config?: Partial<typeof DEFAULT_CONFIG>;
  }

  function simulate(input: SimInput): { prLatencies: number[]; scaffoldLatencies: number[] } {
    const { allocator, clock } = freshAllocator(input.config);
    const tickMs = 1000;

    // Pending arrivals (sorted), and pending releases (slotId + releaseAt).
    const prArrivals = [...input.prSchedule].sort((a, b) => a - b);
    const scafArrivals = [...input.scaffoldSchedule].sort((a, b) => a - b);
    // Map queueId → enqueue time (ms) for latency computation.
    const prEnqueuedAt = new Map<string, number>();
    const scafEnqueuedAt = new Map<string, number>();
    // Map queueId → slotId once bound, so we can schedule its release.
    // Release schedule is a list sorted by releaseAt.
    const releases: Array<{ at: number; slotId: string }> = [];

    const prLatencies: number[] = [];
    const scaffoldLatencies: number[] = [];

    const start = clock.nowMs();

    for (let t = 0; t <= input.runUntilMs; t += tickMs) {
      const nowAbs = start + t;

      // Inject arrivals whose offset is ≤ t.
      while (prArrivals.length > 0 && prArrivals[0] <= t) {
        prArrivals.shift();
        const id = allocator.enqueue('pr_env', { arrivedAt: t });
        prEnqueuedAt.set(id, nowAbs);
      }
      while (scafArrivals.length > 0 && scafArrivals[0] <= t) {
        scafArrivals.shift();
        const id = allocator.enqueue('scaffold', { arrivedAt: t });
        scafEnqueuedAt.set(id, nowAbs);
      }

      // Process any releases due by now.
      while (releases.length > 0 && releases[0].at <= nowAbs) {
        const { slotId } = releases.shift()!;
        allocator.release(slotId);
      }

      // Dispatch.
      const result = allocator.tick();
      for (const d of result.assigned) {
        if (d.class === 'pr_env') {
          const eq = prEnqueuedAt.get(d.queueId);
          if (eq !== undefined) prLatencies.push(nowAbs - eq);
        } else {
          const eq = scafEnqueuedAt.get(d.queueId);
          if (eq !== undefined) scaffoldLatencies.push(nowAbs - eq);
          // Schedule release at nowAbs + scaffoldDurationMs.
          releases.push({ at: nowAbs + input.scaffoldDurationMs, slotId: d.slotId });
          releases.sort((a, b) => a.at - b.at);
        }
      }

      clock.advance(tickMs);
    }

    return { prLatencies, scaffoldLatencies };
  }

  it('PR-env p50/p95 latency under a 50-scaffold spike matches the no-scaffold baseline', () => {
    // Realistic PR env cadence: 8 PR arrivals over the run, spaced 60 s
    // apart, each staying live for the whole test. PRs never release in
    // this simulator (modelling long-lived preview envs), so we cap at 8
    // to exactly fill the dedicated pool without overflow. No PR env
    // should ever need overflow — that's the point of dedicated slots.
    const prSchedule: number[] = [];
    for (let i = 0; i < 8; i++) prSchedule.push(i * 60_000);

    // Spike: 50 scaffolds uniformly distributed over 10 min.
    const scaffoldSchedule: number[] = [];
    for (let i = 0; i < 50; i++) scaffoldSchedule.push(Math.floor((i * 600_000) / 50));

    const runUntilMs = 15 * 60_000; // 15 min — enough drain time after spike

    const baseline = simulate({
      prSchedule,
      scaffoldSchedule: [],
      scaffoldDurationMs: 60_000,
      runUntilMs,
    });
    const spike = simulate({
      prSchedule,
      scaffoldSchedule,
      scaffoldDurationMs: 60_000,
      runUntilMs,
    });

    expect(baseline.prLatencies.length).toBe(prSchedule.length);
    expect(spike.prLatencies.length).toBe(prSchedule.length);

    // Under baseline, every PR env dispatches on the tick following its
    // enqueue → p50 == p95 == one tick (1000 ms) or 0 ms if it dispatched
    // in the same tick as enqueue. Assert spike latencies don't regress.
    expect(percentile(spike.prLatencies, 50)).toBeLessThanOrEqual(
      percentile(baseline.prLatencies, 50),
    );
    expect(percentile(spike.prLatencies, 95)).toBeLessThanOrEqual(
      percentile(baseline.prLatencies, 95),
    );
    // Stronger assertion: PR envs under spike dispatch within a single
    // tick of enqueue — i.e. scaffolding never *even transiently* delays
    // them when dedicated PR capacity is available.
    expect(Math.max(...spike.prLatencies)).toBeLessThanOrEqual(1000);
  });

  it('50 scaffolds all complete within the 10-minute spike window + drain tail', () => {
    // Same spike, but this time we care about scaffold throughput: with
    // 3 dedicated scaffold slots + 1 overflow (PR queue is idle so
    // overflow is available), the pool drains 4 jobs in parallel. At
    // 60 s per job the 50-job batch completes in ceil(50/4) × 60 s = 780 s
    // = 13 min. We give the simulator 20 min total to confirm drain.
    const scaffoldSchedule: number[] = [];
    for (let i = 0; i < 50; i++) scaffoldSchedule.push(Math.floor((i * 600_000) / 50));

    const result = simulate({
      prSchedule: [],
      scaffoldSchedule,
      scaffoldDurationMs: 60_000,
      runUntilMs: 20 * 60_000,
    });

    expect(result.scaffoldLatencies.length).toBe(50);
  });
});

// ─── 2. Fairness — scaffold never preempts a waiting PR env ──────────────

describe('W3 fairness — scaffold never preempts a waiting PR-env on overflow', () => {
  it('a PR env arriving simultaneously with scaffold always wins overflow', () => {
    // Setup: no dedicated slots for either class so the ONLY slot is
    // overflow. This forces the contention we care about.
    const { allocator } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    // Both enqueued at the same clock instant → PR wins.
    const scaf = allocator.enqueue('scaffold', { template: 't' });
    const pr = allocator.enqueue('pr_env', { pr: 1 });

    const result = allocator.tick();
    expect(result.assigned).toHaveLength(1);
    expect(result.assigned[0]).toMatchObject({ queueId: pr, slotId: 'overflow-1' });
    expect(result.scaffoldWaiting).toBe(1);
    void scaf;
  });

  it('with dedicated PR slots all full, a new PR env still beats scaffold to overflow', () => {
    // Realistic demo-day shape: PR envs have saturated their 8 dedicated
    // slots, overflow is free, a scaffold is queued. A new PR arrives →
    // it MUST take overflow, not the queued scaffold.
    const { allocator } = freshAllocator({ prEnvSlots: 2, scaffoldSlots: 3, overflowSlots: 1 });
    // Fill dedicated PR slots.
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.enqueue('pr_env', { pr: 2 });
    allocator.tick();

    // Scaffold arrives — in a W1-style wait world it would sit for 120 s;
    // in the W3 default (0 ms wait) it would take overflow immediately.
    // We enqueue the PR env first so the peek order in tick() sees PR
    // before scaffold, modelling "simultaneous arrival".
    const pr3 = allocator.enqueue('pr_env', { pr: 3 });
    allocator.enqueue('scaffold', { template: 't' });

    const result = allocator.tick();
    const assignedPr = result.assigned.find((d) => d.queueId === pr3);
    expect(assignedPr).toBeDefined();
    expect(assignedPr!.slotId).toBe('overflow-1');
    // Scaffold is NOT bound to overflow; it's either on a dedicated
    // scaffold slot or still queued.
    expect(result.assigned.some((d) => d.class === 'scaffold' && d.slotId === 'overflow-1')).toBe(
      false,
    );
  });

  it('a PR env enqueued while scaffold is waiting claims overflow on the next tick', () => {
    // Scaffold has been queued and overflow is free, but PR arrives
    // before the dispatcher's next tick. PR must claim overflow — no
    // "race to bind" via eager early dispatch.
    const { allocator, clock } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    allocator.enqueue('scaffold', { template: 't' });
    // Simulate the scaffold sitting in queue for a few ticks WITHOUT
    // the allocator running — this is the interval between API POST and
    // the next 1 Hz tick. A PR then arrives during that interval.
    clock.advance(500);
    const pr = allocator.enqueue('pr_env', { pr: 1 });

    const result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([pr]);
    expect(result.assigned[0].slotId).toBe('overflow-1');
  });

  it('once scaffold is bound to overflow, a later PR arrival does NOT preempt it', () => {
    // No preemption is intentional — the overflow slot, once taken by a
    // scaffold under an empty PR queue, stays scaffold's until the
    // container exits. This is the flip side of "PR envs always win
    // contention" — "contention" means queued, not running.
    const { allocator, db } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    const scaf = allocator.enqueue('scaffold', { template: 't' });
    let result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([scaf]);
    expect(boundAtSlot(db, 'overflow-1')).toBe(scaf);

    // PR arrives AFTER scaffold has bound — overflow is unavailable.
    allocator.enqueue('pr_env', { pr: 1 });
    result = allocator.tick();
    expect(result.assigned).toHaveLength(0);
    // Scaffold still bound — no preemption.
    expect(boundAtSlot(db, 'overflow-1')).toBe(scaf);
    expect(result.prEnvWaiting).toBe(1);
  });
});

// ─── 3. Capacity — scaffold concurrency caps at 3 unless overflow is free ─

describe('W3 capacity — scaffold concurrency ≤ 3 unless overflow idle AND PR queue empty', () => {
  it('with PR queue non-empty, scaffolds never exceed 3 concurrent', () => {
    // Scenario: enqueue a never-dispatching PR env (no PR slot available)
    // so the PR queue stays non-empty for the whole test. Then pile on
    // scaffolds and assert ≤ 3 run concurrently.
    const { allocator, db } = freshAllocator({
      prEnvSlots: 0, // no PR slots at all — PR queue can never drain
      scaffoldSlots: 3,
      overflowSlots: 1,
    });
    // Keep a PR enqueued indefinitely — this is the "PR queue non-empty"
    // invariant for the whole test. Even though no dedicated PR slot
    // exists, the PR will try to claim overflow on every tick. The
    // allocator does bind it — so to keep the PR queue permanently
    // non-empty we add a second PR that can never run.
    allocator.enqueue('pr_env', { pr: 'always-waiting-1' });
    allocator.enqueue('pr_env', { pr: 'always-waiting-2' });

    // Enqueue 10 scaffolds. At any tick the overflow slot is either (a)
    // held by a PR env (because PR queue non-empty always wins overflow)
    // or (b) occupied by a binding that we re-create by not releasing
    // anything. So scaffold count stays ≤ 3.
    for (let i = 0; i < 10; i++) allocator.enqueue('scaffold', { template: `t${i}` });

    const result = allocator.tick();
    // The single PR takes overflow; scaffolds fill 3 dedicated slots.
    const scafAssigned = result.assigned.filter((d) => d.class === 'scaffold');
    const prAssigned = result.assigned.filter((d) => d.class === 'pr_env');
    expect(scafAssigned.length).toBe(3);
    expect(prAssigned.length).toBe(1); // the first PR takes overflow
    expect(prAssigned[0].slotId).toBe('overflow-1');
    // Second PR stays queued — PR queue is still non-empty.
    expect(result.prEnvWaiting).toBe(1);
    // Verify concurrency by inspecting slot state.
    const busyScaf = db
      .prepare("SELECT COUNT(*) AS n FROM pool_slots WHERE status = 'busy' AND class = 'scaffold'")
      .get() as { n: number };
    expect(busyScaf.n).toBe(3);
  });

  it('with PR queue empty AND overflow idle, scaffold may run 4 concurrent', () => {
    const { allocator, db } = freshAllocator({
      prEnvSlots: 8,
      scaffoldSlots: 3,
      overflowSlots: 1,
    });
    for (let i = 0; i < 10; i++) allocator.enqueue('scaffold', { template: `t${i}` });

    allocator.tick();
    // Expect 3 dedicated + 1 overflow = 4 scaffolds running concurrently.
    expect(busyScaffoldCount(db)).toBe(4);
  });

  it('scaffold concurrency never exceeds 3 while a PR env is queued waiting for overflow', () => {
    // Two PRs enqueued: PR-1 takes overflow, PR-2 waits. With PR-2 in
    // queue, overflow is "claimed by pending PR" and no scaffold may use
    // it even if overflow later becomes free.
    const { allocator, db } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 3,
      overflowSlots: 1,
    });
    allocator.enqueue('pr_env', { pr: 1 });
    allocator.enqueue('pr_env', { pr: 2 });
    for (let i = 0; i < 5; i++) allocator.enqueue('scaffold', { template: `t${i}` });

    let result = allocator.tick();
    // PR-1 → overflow, 3 scaffolds → dedicated. PR-2 still queued.
    expect(
      result.assigned.filter((d) => d.class === 'pr_env' && d.slotId === 'overflow-1'),
    ).toHaveLength(1);
    expect(result.prEnvWaiting).toBe(1);

    // Now "release" overflow (simulating PR-1 container exit). The next
    // tick MUST give overflow to PR-2 — NOT to a scaffold — because PR
    // queue is non-empty.
    allocator.release('overflow-1');
    result = allocator.tick();
    const overflowBinding = result.assigned.find((d) => d.slotId === 'overflow-1');
    expect(overflowBinding).toBeDefined();
    expect(overflowBinding!.class).toBe('pr_env');
    // Still only 3 scaffolds running — overflow did not go to scaffold.
    const busyScaf = db
      .prepare("SELECT COUNT(*) AS n FROM pool_slots WHERE status = 'busy' AND class = 'scaffold'")
      .get() as { n: number };
    expect(busyScaf.n).toBe(3);
  });

  it('scaffold fills overflow immediately after PR queue drains (no bounded wait)', () => {
    // The W3 rule is "scaffold may take overflow iff PR queue is empty".
    // Confirm: as soon as the last PR env binds and the PR queue is
    // empty, the NEXT tick lets scaffold take overflow — no bounded
    // wait, no delay beyond the 1 Hz tick cadence itself.
    const { allocator } = freshAllocator({
      prEnvSlots: 0,
      scaffoldSlots: 0,
      overflowSlots: 1,
    });
    const pr = allocator.enqueue('pr_env', { pr: 1 });
    const scaf = allocator.enqueue('scaffold', { template: 't' });

    let result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([pr]);

    // Simulate PR container exiting → release overflow.
    allocator.release('overflow-1');
    result = allocator.tick();
    expect(result.assigned.map((d) => d.queueId)).toEqual([scaf]);
    expect(result.assigned[0].slotId).toBe('overflow-1');
  });
});
