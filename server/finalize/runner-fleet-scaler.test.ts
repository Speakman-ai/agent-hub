import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import {
  desiredAgents,
  planFleetChange,
  REAP_SCALE_DOWN_GRACE_MS,
  SCALE_DOWN_COOLDOWN_MS,
  type ScalerHysteresis,
} from './runner-fleet-scaler.js';
import { getOrgsDb, initOrgsDb, setOrgsDbPathForTests } from '../orgs.js';
import {
  claimRunnerJob,
  enqueueRunnerJob,
  reapExpiredRunnerLeases,
  runnerQueueDepth,
} from './runner-queue.js';

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
});
