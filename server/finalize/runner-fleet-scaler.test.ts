import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  __resetFleetScalerStateForTests,
  desiredAgents,
  desiredAgentsDynamic,
  planFleetChange,
  REAP_SCALE_DOWN_GRACE_MS,
  reapDeadRunnerJobs,
  SCALE_DOWN_COOLDOWN_MS,
  startFleetScaler,
  type ScalerHysteresis,
} from './runner-fleet-scaler.js';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  claimRunnerJob,
  enqueueRunnerJob,
  markRunnerJobRunning,
  probeRunnerJobLoss,
  reapExpiredRunnerLeases,
  runnerInflightCount,
  runnerQueueDepth,
} from './runner-queue.js';
import { createJobChannel, removeJobChannel } from './runner-job-channel.js';

describe('desiredAgents', () => {
  it('scales to zero (min) when the queue is empty', () => {
    expect(desiredAgents(0, 0, 8)).toBe(0);
    expect(desiredAgents(0, 1, 8)).toBe(1); // warm pool floor
  });

  it('matches agent count to queue depth between min and max', () => {
    expect(desiredAgents(1, 0, 8)).toBe(1);
    expect(desiredAgents(5, 0, 8)).toBe(5);
  });

  it('caps at max (excess jobs wait in the queue)', () => {
    expect(desiredAgents(20, 0, 8)).toBe(8);
  });

  it('never drops below the floor while work is queued', () => {
    expect(desiredAgents(2, 4, 8)).toBe(4);
  });
});

describe('desiredAgentsDynamic (queued backlog vs in-flight separation)', () => {
  it('shrinks to in-flight + headroom when the queue is drained', () => {
    // depth == inflight (queued=0): the pure long-tail case.
    expect(desiredAgentsDynamic(2, 2, 0, 0, 64)).toBe(2);
    expect(desiredAgentsDynamic(2, 2, 3, 0, 64)).toBe(5); // + warm headroom
  });

  it('holds at depth for a real backlog (queued work is NOT starved)', () => {
    // 2 running + 48 queued: idle agents will claim the 48, so keep the fleet.
    expect(desiredAgentsDynamic(50, 2, 0, 0, 64)).toBe(50);
  });

  it('does NOT stack headroom on top of a backlog', () => {
    // max(depth, inflight+headroom) = max(50, 5) = 50, never 53.
    expect(desiredAgentsDynamic(50, 2, 3, 0, 64)).toBe(50);
  });

  it('never targets below in-flight work', () => {
    expect(desiredAgentsDynamic(6, 6, 0, 0, 64)).toBe(6);
    expect(desiredAgentsDynamic(10, 10, 0, 0, 64)).toBe(10);
  });

  it('collapses to the floor only when fully drained', () => {
    expect(desiredAgentsDynamic(0, 0, 0, 0, 64)).toBe(0);
    expect(desiredAgentsDynamic(0, 0, 5, 2, 64)).toBe(2); // min floor
  });

  it('caps at max (headroom and backlog both clamp)', () => {
    expect(desiredAgentsDynamic(7, 7, 5, 0, 8)).toBe(8); // 7+5 → clamp 8
    expect(desiredAgentsDynamic(50, 2, 0, 0, 8)).toBe(8); // backlog → clamp 8
  });

  it('never returns below in-flight even when max < inflight', () => {
    // max lowered to 3 while 5 jobs are running → keep all 5, exceed the ceiling.
    expect(desiredAgentsDynamic(5, 5, 0, 0, 3)).toBe(5);
    // depth and backlog both exceed an undersized max → still floored at inflight.
    expect(desiredAgentsDynamic(10, 8, 0, 0, 4)).toBe(8);
    // headroom can't push below inflight either (it only ever adds).
    expect(desiredAgentsDynamic(6, 6, 2, 0, 2)).toBe(6);
  });
});

const FRESH: ScalerHysteresis = { emptySinceMs: 0, lastReapAtMs: 0 };

describe('planFleetChange', () => {
  it('scales up immediately and clears the empty anchor', () => {
    const p = planFleetChange({
      depth: 5,
      current: 1,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000,
      state: { emptySinceMs: 500, lastReapAtMs: 0 },
    });
    expect(p.target).toBe(5);
    expect(p.state.emptySinceMs).toBe(0);
  });

  it('leaves the service unchanged when target already equals current', () => {
    const p = planFleetChange({
      depth: 3,
      current: 3,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
    });
    expect(p.target).toBeNull();
  });

  it('never shrinks while work is still queued/claimed/running', () => {
    // min floor below depth would shrink, but depth > 0 forbids it.
    const p = planFleetChange({
      depth: 2,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
    });
    expect(p.target).toBeNull();
  });

  it('shrinks only after the drain cooldown elapses', () => {
    const armed = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
    });
    expect(armed.target).toBeNull(); // cooldown just started
    expect(armed.state.emptySinceMs).toBe(1_000);

    const stillCooling = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS - 1,
      state: armed.state,
    });
    expect(stillCooling.target).toBeNull();

    const drained = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
    });
    expect(drained.target).toBe(0); // genuinely empty long enough → shrink
  });

  // ── Regression: the 2026-06-08 incident ──────────────────────────────────
  // A reaper tick marks all in-flight jobs `lost`, so depth reads 0 while the
  // orchestrator is about to retry them. The scaler MUST NOT scale to 0 (that
  // SIGKILLed all 8 live agents mid-build). It must hold until retries re-queue.
  it('does NOT scale down on a reap-induced empty reading (incident regression)', () => {
    const reapTick = planFleetChange({
      depth: 0, // 8 in-flight jobs just reaped to `lost` → depth collapsed
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 8,
      now: 10_000,
      state: FRESH,
    });
    expect(reapTick.target).toBeNull(); // <-- would have been 0 before the fix
    expect(reapTick.state.lastReapAtMs).toBe(10_000);

    // Even past the ordinary drain cooldown, the reap grace still suppresses it.
    const afterCooldown = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 10_000 + SCALE_DOWN_COOLDOWN_MS + 1,
      state: reapTick.state,
    });
    expect(afterCooldown.target).toBeNull();
    expect(SCALE_DOWN_COOLDOWN_MS).toBeLessThan(REAP_SCALE_DOWN_GRACE_MS);
  });

  it('retries that re-raise depth keep the fleet warm (no shrink at all)', () => {
    const reapTick = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 8,
      now: 10_000,
      state: FRESH,
    });
    // Orchestrator re-enqueues the retries within the grace window → depth > 0.
    const requeued = planFleetChange({
      depth: 6,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 10_000 + 30_000,
      state: reapTick.state,
    });
    expect(requeued.target).toBeNull(); // depth>0 but < current → hold, never kill
  });

  it('still scales down once the grace AND cooldown both clear with no retries', () => {
    const reapTick = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 1,
      now: 10_000,
      state: FRESH,
    });
    const settled = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 10_000 + REAP_SCALE_DOWN_GRACE_MS,
      state: reapTick.state,
    });
    expect(settled.target).toBe(0); // genuinely drained, no retries appeared
  });
});

// ── Dynamic scale-down (FINALIZE_FLEET_DYNAMIC_SCALE_DOWN) ──────────────────
// The default scaler holds the whole warm fleet until depth==0, so a long tail
// of a few jobs pins dozens of idle runners. Dynamic mode trims the idle ones
// mid-run down to in-flight (+ headroom), leaning on ECS task scale-in
// protection to keep the busy tasks alive.
describe('planFleetChange — dynamic scale-down', () => {
  it('legacy (default) mode still never shrinks mid-run', () => {
    const p = planFleetChange({
      depth: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: false,
    });
    expect(p.target).toBeNull();
  });

  it('trims idle agents to in-flight while jobs run (after the cooldown)', () => {
    // 50 runners out, 2 jobs running, 0 queued → depth=inflight=2. Long tail.
    const armed = planFleetChange({
      depth: 2,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    expect(armed.target).toBeNull(); // shrink-debounce anchor just started
    expect(armed.state.emptySinceMs).toBe(1_000);

    const shrink = planFleetChange({
      depth: 2,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
      dynamicScaleDown: true,
    });
    // Collapses to the 2 in-flight jobs; ECS task protection keeps those 2 tasks,
    // scale-in reaps the 48 idle ones.
    expect(shrink.target).toBe(2);
  });

  // Reviewer regression: a queued backlog must NOT be conflated with in-flight
  // work. 2 running + 48 queued → depth=50, inflight=2. The fleet must HOLD at
  // 50 (the 48 idle agents will claim the 48 queued jobs), not shrink to ~2 and
  // starve the queue.
  it('does NOT trim while a real queued backlog exists (no starvation)', () => {
    const plan = planFleetChange({
      depth: 50, // 2 running + 48 queued
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
      warmHeadroom: 3,
    });
    expect(plan.target).toBeNull(); // target=max(50, 2+3)=50 == current → hold
  });

  it('shrinks toward depth as the backlog drains, never below in-flight', () => {
    // Queue partially drained: 2 running + 18 queued → depth=20, inflight=2.
    const armed = planFleetChange({
      depth: 20,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    const shrink = planFleetChange({
      depth: 20,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
      dynamicScaleDown: true,
    });
    expect(shrink.target).toBe(20); // serve the remaining backlog, drop the rest
  });

  it('refuses a mid-run shrink below in-flight when max < inflight', () => {
    // 8 jobs running, but max was lowered to 3. A shrink must NOT target 3 (that
    // would drop desiredCount below the busy agents); it floors at inflight=8.
    const armed = planFleetChange({
      depth: 8,
      inflight: 8,
      current: 20,
      min: 0,
      max: 3,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    const shrink = planFleetChange({
      depth: 8,
      inflight: 8,
      current: 20,
      min: 0,
      max: 3,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
      dynamicScaleDown: true,
    });
    expect(shrink.target).toBe(8); // floored at in-flight, not clamped to max=3
  });

  it('keeps warm headroom above in-flight work when configured', () => {
    const armed = planFleetChange({
      depth: 2,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
      warmHeadroom: 3,
    });
    const shrink = planFleetChange({
      depth: 2,
      inflight: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
      dynamicScaleDown: true,
      warmHeadroom: 3,
    });
    expect(shrink.target).toBe(5); // 2 in-flight + 3 warm spares
  });

  it('never targets below in-flight work (headroom only adds, never subtracts)', () => {
    // depth here is all claimed/running; target must be >= depth regardless.
    const shrink = planFleetChange({
      depth: 6,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: SCALE_DOWN_COOLDOWN_MS + 1,
      state: { emptySinceMs: 1, lastReapAtMs: 0 },
      dynamicScaleDown: true,
    });
    expect(shrink.target).not.toBeNull();
    expect(shrink.target as number).toBeGreaterThanOrEqual(6);
  });

  it('respects max when headroom would overshoot it', () => {
    const shrink = planFleetChange({
      depth: 7,
      current: 64,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: SCALE_DOWN_COOLDOWN_MS + 1,
      state: { emptySinceMs: 1, lastReapAtMs: 0 },
      dynamicScaleDown: true,
      warmHeadroom: 5,
    });
    expect(shrink.target).toBe(8); // 7 + 5 clamped to max
  });

  it('reap-grace still suppresses a dynamic mid-run shrink (incident guard holds)', () => {
    const reapTick = planFleetChange({
      depth: 2, // 2 still running, but a lease was just reaped
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 1,
      now: 10_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    expect(reapTick.target).toBeNull();
    expect(reapTick.state.lastReapAtMs).toBe(10_000);

    // Past the ordinary cooldown but still inside the reap grace → still held.
    const stillGraced = planFleetChange({
      depth: 2,
      current: 50,
      min: 0,
      max: 64,
      reapedThisTick: 0,
      now: 10_000 + SCALE_DOWN_COOLDOWN_MS + 1,
      state: reapTick.state,
      dynamicScaleDown: true,
    });
    expect(stillGraced.target).toBeNull();
  });

  it('a fully drained queue still collapses to min in dynamic mode', () => {
    const armed = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    const drained = planFleetChange({
      depth: 0,
      current: 8,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 1_000 + SCALE_DOWN_COOLDOWN_MS,
      state: armed.state,
      dynamicScaleDown: true,
    });
    expect(drained.target).toBe(0);
  });
});

// Wire the REAL reaper to the decision so the test fails if either side drifts:
// reaping must zero the depth, and the planner must refuse to scale down on it.
describe('reap → scaler integration (real queue)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-scaler-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });
  afterEach(() => {
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('a mass reap zeroes depth but the planner holds the fleet', () => {
    const N = 8;
    for (let i = 0; i < N; i++) {
      enqueueRunnerJob({
        orgId: 'orgA',
        projectId: 'p1',
        runId: 'r1',
        jobId: `j${i}`,
        matrixKey: '',
        image: 'img:latest',
        specJson: '{}',
        now: 1_000,
      });
      claimRunnerJob({ agentId: `agent-${i}`, leaseMs: 10_000, now: 2_000 });
    }
    expect(runnerQueueDepth()).toBe(N); // all claimed/in-flight
    void getOrgsDb(); // ensure db is materialized

    const now = 2_000 + 10_000 + 1; // past every lease
    const reaped = reapExpiredRunnerLeases(now);
    expect(reaped).toHaveLength(N);
    expect(runnerQueueDepth()).toBe(0); // the collapse that fooled the old scaler

    const plan = planFleetChange({
      depth: runnerQueueDepth(),
      current: N,
      min: 0,
      max: 8,
      reapedThisTick: reaped.length,
      now,
      state: FRESH,
    });
    expect(plan.target).toBeNull(); // fleet preserved despite depth=0
  });

  it('inflight count excludes queued work so a backlog is not trimmed', () => {
    // 6 jobs: 2 claimed+running (in-flight), 4 still queued.
    for (let i = 0; i < 6; i++) {
      enqueueRunnerJob({
        orgId: 'orgA',
        projectId: 'p1',
        runId: 'r1',
        jobId: `j${i}`,
        matrixKey: '',
        image: 'img:latest',
        specJson: '{}',
        now: 1_000,
      });
    }
    const a = claimRunnerJob({ agentId: 'agent-0', leaseMs: 60_000, now: 2_000 });
    const b = claimRunnerJob({ agentId: 'agent-1', leaseMs: 60_000, now: 2_000 });
    markRunnerJobRunning(a!.id, 2_100);
    markRunnerJobRunning(b!.id, 2_100);

    expect(runnerQueueDepth()).toBe(6); // 2 in-flight + 4 queued
    expect(runnerInflightCount()).toBe(2); // claimed/running only

    // With a real backlog, the planner holds the fleet (serves the 4 queued)
    // rather than collapsing to the 2 in-flight.
    const plan = planFleetChange({
      depth: runnerQueueDepth(),
      inflight: runnerInflightCount(),
      current: 6,
      min: 0,
      max: 8,
      reapedThisTick: 0,
      now: 3_000,
      state: FRESH,
      dynamicScaleDown: true,
    });
    expect(plan.target).toBeNull(); // target=max(6,2)=6 == current → hold
  });
});

// Regression (card d8a76929): lease reaping is the liveness backstop that
// settles a Finalize step whose remote runner-agent died — without it the
// step's promise hangs until the per-step hard timeout (up to 60 min).
// Historically the reap only ran inside the ECS fleet-scaler tick, so a
// static/manual runner fleet (no FINALIZE_FLEET_ECS_* env) had NO reaping at
// all. reapDeadRunnerJobs is now standalone and startFleetScaler runs it even
// when no ECS fleet is configured.
describe('reapDeadRunnerJobs (liveness backstop, card d8a76929)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-reaper-'));
    setOrgsDbPathForTests(path.join(dir, 'orgs.db'));
    initOrgsDb();
  });
  afterEach(() => {
    __resetFleetScalerStateForTests();
    setOrgsDbPathForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails the in-process job channel when a lease expires, settling the awaiting step', async () => {
    enqueueRunnerJob({
      orgId: 'orgA',
      projectId: 'p1',
      runId: 'r1',
      jobId: 'electron',
      matrixKey: '',
      image: 'img:latest',
      specJson: '{}',
      now: 1_000,
    });
    const claimed = claimRunnerJob({ agentId: 'agent-0', leaseMs: 10_000, now: 2_000 });
    expect(claimed).not.toBeNull();
    const channel = createJobChannel(claimed!.id);
    let failure: Error | null = null;
    channel.ready.catch((err: Error) => {
      failure = err;
    });

    const reaped = reapDeadRunnerJobs(2_000 + 10_000 + 1); // past the lease
    expect(reaped).toHaveLength(1);
    expect(reaped[0].id).toBe(claimed!.id);
    // The channel was failed, so anything awaiting the agent unblocks with a
    // retryable runner-loss error instead of hanging.
    await Promise.resolve();
    expect(failure).not.toBeNull();
    expect(failure!.message).toMatch(/runner agent lost — lease expired with no heartbeat/);
    removeJobChannel(claimed!.id);
  });

  it('startFleetScaler reaps expired leases even with no ECS fleet configured', () => {
    const savedCluster = process.env.FINALIZE_FLEET_ECS_CLUSTER;
    const savedService = process.env.FINALIZE_FLEET_ECS_SERVICE;
    delete process.env.FINALIZE_FLEET_ECS_CLUSTER;
    delete process.env.FINALIZE_FLEET_ECS_SERVICE;
    try {
      enqueueRunnerJob({
        orgId: 'orgA',
        projectId: 'p1',
        runId: 'r1',
        jobId: 'electron',
        matrixKey: '',
        image: 'img:latest',
        specJson: '{}',
        now: Date.now() - 400_000,
      });
      const claimed = claimRunnerJob({
        agentId: 'agent-0',
        leaseMs: 10_000,
        now: Date.now() - 400_000, // lease long expired vs the real clock
      });
      expect(claimed).not.toBeNull();

      // No FINALIZE_FLEET_ECS_* config: previously this returned without
      // starting anything, leaving dead leases unreaped forever.
      startFleetScaler(3_600_000);

      const probe = probeRunnerJobLoss(claimed!.id, Date.now());
      expect(probe).not.toBeNull();
      expect(probe!.state).toBe('lost');
      expect(probe!.lost).toBe(true);
    } finally {
      if (savedCluster !== undefined) process.env.FINALIZE_FLEET_ECS_CLUSTER = savedCluster;
      if (savedService !== undefined) process.env.FINALIZE_FLEET_ECS_SERVICE = savedService;
    }
  });
});
