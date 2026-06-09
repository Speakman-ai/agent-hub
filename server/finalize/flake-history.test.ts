import { describe, it, expect } from 'vitest';
import {
  computeFlakeRate,
  deriveRunInstanceOutcomes,
  instanceKey,
  isFlaky,
  summarizeFlakeHistory,
  type FlakeHistoryRecord,
} from './flake-history.js';
import type { JobRoundAttempt } from './flake-recovery.js';

// headSha defaults to a CONSTANT so multi-round attempts share a head unless a
// test overrides it — i.e. the default scenario is a same-head rerun. A flake
// is only a fail→pass on the SAME head; pass a differing headSha to model a
// fixer commit landing between rounds.
function attempt(
  jobId: string,
  round: number,
  state: JobRoundAttempt['state'],
  matrixKey = '',
  headSha: string | null = 'h',
): JobRoundAttempt {
  return { jobId, matrixKey, round, state, headSha };
}

describe('deriveRunInstanceOutcomes', () => {
  it('marks a passed-first instance as not flaked', () => {
    const out = deriveRunInstanceOutcomes([attempt('e2e', 1, 'passed')]);
    expect(out).toEqual([{ jobId: 'e2e', matrixKey: '', finalState: 'passed', flaked: false }]);
  });

  it('marks a same-head failed-then-passed instance as flaked (bare rerun-to-green)', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('e2e', 1, 'failed', '', 'h'),
      attempt('e2e', 2, 'passed', '', 'h'),
    ]);
    expect(out).toEqual([{ jobId: 'e2e', matrixKey: '', finalState: 'passed', flaked: true }]);
  });

  it('does NOT flag a fix that changed the head (failed@oldSha then passed@newSha)', () => {
    // A commit landed between the failing and passing rounds — this is a
    // (possible) real fix, not a flake. Counting it would brand every normal
    // finalize fix as flaky and contaminate /finalize/flakes.
    const out = deriveRunInstanceOutcomes([
      attempt('backend', 1, 'failed', '', 'old'),
      attempt('backend', 2, 'passed', '', 'new'),
    ]);
    expect(out).toEqual([{ jobId: 'backend', matrixKey: '', finalState: 'passed', flaked: false }]);
  });

  it('does not flag when heads are unknown (null on either side)', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('e2e', 1, 'failed', '', null),
      attempt('e2e', 2, 'passed', '', null),
    ]);
    expect(out[0].flaked).toBe(false);
  });

  it('flags a same-head rerun even when a later round changed the head', () => {
    // failed@h1, passed@h1 (rerun flake), then a commit moves to h2 and passes.
    const out = deriveRunInstanceOutcomes([
      attempt('e2e', 1, 'failed', '', 'h1'),
      attempt('e2e', 2, 'passed', '', 'h1'),
      attempt('e2e', 3, 'passed', '', 'h2'),
    ]);
    expect(out[0]).toMatchObject({ finalState: 'passed', flaked: true });
  });

  it('a still-failing instance is failed and not flaked', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('backend', 1, 'failed'),
      attempt('backend', 2, 'failed'),
    ]);
    expect(out).toEqual([{ jobId: 'backend', matrixKey: '', finalState: 'failed', flaked: false }]);
  });

  it('passed-then-failed (regressed) is failed and not flaked', () => {
    // No earlier-failure-before-a-pass, so not an in-run flake recovery.
    const out = deriveRunInstanceOutcomes([attempt('x', 1, 'passed'), attempt('x', 2, 'failed')]);
    expect(out).toEqual([{ jobId: 'x', matrixKey: '', finalState: 'failed', flaked: false }]);
  });

  it('ignores non-terminal observations and drops instances with no terminal state', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('queued-only', 1, 'queued'),
      attempt('queued-only', 2, 'running'),
      attempt('skip', 1, 'skipped'),
    ]);
    expect(out).toEqual([]);
  });

  it('keys distinct matrix shards independently', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('e2e', 1, 'failed', 'shard-1'),
      attempt('e2e', 2, 'passed', 'shard-1'),
      attempt('e2e', 1, 'passed', 'shard-2'),
    ]);
    const byKey = Object.fromEntries(out.map((o) => [o.matrixKey, o]));
    expect(byKey['shard-1'].flaked).toBe(true);
    expect(byKey['shard-2'].flaked).toBe(false);
  });

  it('handles attempts arriving out of round order', () => {
    const out = deriveRunInstanceOutcomes([
      attempt('e2e', 2, 'passed'),
      attempt('e2e', 1, 'failed'),
    ]);
    expect(out[0]).toMatchObject({ finalState: 'passed', flaked: true });
  });
});

describe('computeFlakeRate', () => {
  const rec = (finalState: 'passed' | 'failed', flaked: boolean): FlakeHistoryRecord => ({
    jobId: 'e2e',
    matrixKey: '',
    finalState,
    flaked,
    recordedAt: 1,
  });

  it('is all-zero for no history', () => {
    expect(computeFlakeRate([])).toEqual({
      runs: 0,
      failedRuns: 0,
      flakedRuns: 0,
      flakeRate: 0,
      failRate: 0,
    });
  });

  it('a perfectly green instance has rate 0', () => {
    const r = computeFlakeRate([rec('passed', false), rec('passed', false)]);
    expect(r.flakeRate).toBe(0);
    expect(r.failRate).toBe(0);
  });

  it('counts a flaked-but-passed run as unreliable', () => {
    // 4 runs: 1 flaked-pass, 1 clean fail, 2 clean pass → unreliable = 2/4.
    const r = computeFlakeRate([
      rec('passed', true),
      rec('failed', false),
      rec('passed', false),
      rec('passed', false),
    ]);
    expect(r.runs).toBe(4);
    expect(r.flakedRuns).toBe(1);
    expect(r.failedRuns).toBe(1);
    expect(r.flakeRate).toBeCloseTo(0.5);
    expect(r.failRate).toBeCloseTo(0.25);
  });

  it('does not double-count a run that both flaked and ended failed', () => {
    // A run that flaked AND ended failed counts once toward the unreliable set.
    const r = computeFlakeRate([rec('failed', true), rec('passed', false)]);
    expect(r.flakeRate).toBeCloseTo(0.5);
  });

  it('all runs failing yields rate 1', () => {
    const r = computeFlakeRate([rec('failed', false), rec('failed', false)]);
    expect(r.flakeRate).toBe(1);
    expect(r.failRate).toBe(1);
  });
});

describe('summarizeFlakeHistory', () => {
  it('groups by instance and sorts flakiest first', () => {
    const records = [
      {
        jobId: 'stable',
        matrixKey: '',
        finalState: 'passed' as const,
        flaked: false,
        recordedAt: 10,
      },
      {
        jobId: 'stable',
        matrixKey: '',
        finalState: 'passed' as const,
        flaked: false,
        recordedAt: 20,
      },
      {
        jobId: 'flaky',
        matrixKey: '',
        finalState: 'passed' as const,
        flaked: true,
        recordedAt: 30,
      },
      {
        jobId: 'flaky',
        matrixKey: '',
        finalState: 'failed' as const,
        flaked: false,
        recordedAt: 40,
      },
    ];
    const stats = summarizeFlakeHistory(records);
    expect(stats[0].jobId).toBe('flaky');
    expect(stats[0].flakeRate).toBe(1);
    expect(stats[0].lastSeen).toBe(40);
    expect(stats[1].jobId).toBe('stable');
    expect(stats[1].flakeRate).toBe(0);
  });

  it('keeps instances distinct when a space-join key would collide', () => {
    // ('a b','c') and ('a','b c') both produce "a b c" under a naive space
    // join — the collision the structured key prevents. They must stay two
    // distinct instances.
    const records = [
      { jobId: 'a b', matrixKey: 'c', finalState: 'failed' as const, flaked: false, recordedAt: 1 },
      { jobId: 'a', matrixKey: 'b c', finalState: 'passed' as const, flaked: false, recordedAt: 2 },
    ];
    const stats = summarizeFlakeHistory(records);
    expect(stats).toHaveLength(2);
    const keys = stats.map((s) => instanceKey(s.jobId, s.matrixKey));
    expect(new Set(keys).size).toBe(2);
  });
});

describe('instanceKey', () => {
  it('is collision-free for pairs that a space join would conflate', () => {
    expect(instanceKey('a b', 'c')).not.toBe(instanceKey('a', 'b c'));
  });

  it('round-trips identical pairs to the same key and normalizes empty matrix', () => {
    expect(instanceKey('e2e', 'shard-1')).toBe(instanceKey('e2e', 'shard-1'));
    expect(instanceKey('e2e', '')).toBe(instanceKey('e2e', undefined as unknown as string));
  });
});

describe('isFlaky', () => {
  const stat = (runs: number, flakeRate: number) => ({
    runs,
    failedRuns: 0,
    flakedRuns: 0,
    flakeRate,
    failRate: 0,
  });

  it('requires a minimum sample size', () => {
    expect(isFlaky(stat(2, 1))).toBe(false); // only 2 runs < default minRuns 3
    expect(isFlaky(stat(3, 0.5))).toBe(true);
  });

  it('respects the flake-rate threshold', () => {
    expect(isFlaky(stat(10, 0.1))).toBe(false); // not strictly above 0.1
    expect(isFlaky(stat(10, 0.11))).toBe(true);
  });

  it('honours custom thresholds', () => {
    expect(isFlaky(stat(5, 0.3), { minRuns: 6, minFlakeRate: 0.2 })).toBe(false);
    expect(isFlaky(stat(6, 0.3), { minRuns: 6, minFlakeRate: 0.2 })).toBe(true);
  });
});
