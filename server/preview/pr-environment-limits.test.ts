import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PR_ENVIRONMENT_LIMITS,
  PrEnvironmentLimitsPatchSchema,
  applyPrEnvironmentLimitsPatch,
  planPrEnvironmentSweep,
  resolvePrEnvironmentLimits,
  selectEvictions,
  enforcedPrEnvironmentLimits,
  type PrEnvironmentUsage,
} from './pr-environment-limits.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

function usage(over: Partial<PrEnvironmentUsage> & { id: string }): PrEnvironmentUsage {
  return {
    status: 'ready',
    stopReason: null,
    cleanupPending: false,
    createdAt: 0,
    readyAt: 0,
    lastHitAt: null,
    renewedAt: 0,
    ...over,
  };
}

describe('resolvePrEnvironmentLimits', () => {
  it('uses defaults when the project sets nothing', () => {
    expect(resolvePrEnvironmentLimits({})).toEqual(DEFAULT_PR_ENVIRONMENT_LIMITS);
    expect(resolvePrEnvironmentLimits(null)).toEqual(DEFAULT_PR_ENVIRONMENT_LIMITS);
  });

  it('applies valid overrides, keeps 0 as off, and ignores out-of-bounds values', () => {
    expect(
      resolvePrEnvironmentLimits({
        prEnvironmentLimits: { maxConcurrent: 2, idleTtlMinutes: 0, maxLifetimeDays: 9999 },
      }),
    ).toEqual({
      maxConcurrent: 2,
      idleTtlMinutes: 0,
      maxLifetimeDays: DEFAULT_PR_ENVIRONMENT_LIMITS.maxLifetimeDays,
    });
  });
});

describe('limits patch', () => {
  it('rejects out-of-bounds values and unknown keys', () => {
    expect(PrEnvironmentLimitsPatchSchema.safeParse({ idleTtlMinutes: 1 }).success).toBe(false);
    expect(PrEnvironmentLimitsPatchSchema.safeParse({ maxConcurrent: 1.5 }).success).toBe(false);
    expect(PrEnvironmentLimitsPatchSchema.safeParse({ other: 1 }).success).toBe(false);
    expect(PrEnvironmentLimitsPatchSchema.safeParse({ maxConcurrent: 0 }).success).toBe(true);
  });

  it('null resets a field; resetting everything clears the overrides', () => {
    const stored = applyPrEnvironmentLimitsPatch(null, { maxConcurrent: 3, idleTtlMinutes: 30 });
    expect(stored).toEqual({ maxConcurrent: 3, idleTtlMinutes: 30 });
    expect(applyPrEnvironmentLimitsPatch(stored, { maxConcurrent: null })).toEqual({
      idleTtlMinutes: 30,
    });
    expect(
      applyPrEnvironmentLimitsPatch(stored, { maxConcurrent: null, idleTtlMinutes: null }),
    ).toBeNull();
  });
});

describe('selectEvictions', () => {
  it('stops ready environments least recently used first', () => {
    const live = [
      usage({ id: 'recent-hit', readyAt: 100, lastHitAt: 5_000 }),
      usage({ id: 'old-hit', readyAt: 100, lastHitAt: 1_000 }),
      usage({ id: 'never-hit-new', readyAt: 3_000 }),
      usage({ id: 'never-hit-old', readyAt: 200 }),
    ];
    expect(selectEvictions(live, 2).map((e) => e.id)).toEqual(['never-hit-old', 'old-hit']);
  });

  it('only stops a build in flight when there are not enough ready ones', () => {
    const live = [
      usage({ id: 'building-old', status: 'building', createdAt: 1, readyAt: null }),
      usage({ id: 'ready-recent', readyAt: 9_000 }),
    ];
    expect(selectEvictions(live, 1).map((e) => e.id)).toEqual(['ready-recent']);
    expect(selectEvictions(live, 0).map((e) => e.id)).toEqual(['ready-recent', 'building-old']);
  });

  it('returns nothing under the cap', () => {
    expect(selectEvictions([usage({ id: 'a' })], 1)).toEqual([]);
  });
});

describe('planPrEnvironmentSweep', () => {
  const limits = { maxConcurrent: 2, idleTtlMinutes: 60, maxLifetimeDays: 14 };

  it('expires stale envs, sleeps idle ones, then enforces the cap on the rest', () => {
    const now = 20 * DAY;
    const envs = [
      usage({ id: 'stale', renewedAt: 0, readyAt: now - MIN, lastHitAt: now - MIN }),
      usage({ id: 'idle', renewedAt: now - DAY, readyAt: now - 2 * 60 * MIN }),
      usage({ id: 'a', renewedAt: now - DAY, readyAt: now - 30 * MIN }),
      usage({ id: 'b', renewedAt: now - DAY, readyAt: now - 20 * MIN }),
      usage({ id: 'c', renewedAt: now - DAY, readyAt: now - 10 * MIN }),
      usage({ id: 'failed', status: 'failed', renewedAt: 0 }),
    ];
    expect(planPrEnvironmentSweep(envs, limits, now)).toEqual([
      { id: 'stale', action: 'expire', reason: 'expired' },
      { id: 'idle', action: 'idle', reason: 'idle' },
      { id: 'a', action: 'idle', reason: 'cap' },
    ]);
  });

  it('a recent request keeps an environment awake', () => {
    const now = 10 * 60 * MIN;
    const env = usage({ id: 'x', renewedAt: now, readyAt: 0, lastHitAt: now - 5 * MIN });
    expect(planPrEnvironmentSweep([env], limits, now)).toEqual([]);
  });

  it('marks a sleeping env expired once its PR goes stale', () => {
    const env = usage({ id: 's', status: 'stopped', stopReason: 'idle', renewedAt: 0 });
    expect(planPrEnvironmentSweep([env], limits, 15 * DAY)).toEqual([
      { id: 's', action: 'expire', reason: 'expired' },
    ]);
    expect(planPrEnvironmentSweep([env], limits, 2 * DAY)).toEqual([]);
  });

  it('0 turns each control off', () => {
    const off = { maxConcurrent: 0, idleTtlMinutes: 0, maxLifetimeDays: 0 };
    const envs = [usage({ id: 'a' }), usage({ id: 'b' }), usage({ id: 'c' })];
    expect(planPrEnvironmentSweep(envs, off, 365 * DAY)).toEqual([]);
  });
});

describe('enforcedPrEnvironmentLimits', () => {
  it('turns idle sleep off when requests cannot wake an environment', () => {
    const l = { maxConcurrent: 3, idleTtlMinutes: 60, maxLifetimeDays: 14 };
    expect(enforcedPrEnvironmentLimits(l, true)).toEqual(l);
    expect(enforcedPrEnvironmentLimits(l, false)).toEqual({ ...l, idleTtlMinutes: 0 });
  });
});
