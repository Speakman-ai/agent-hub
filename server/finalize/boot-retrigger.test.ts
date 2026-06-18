import { describe, it, expect, vi } from 'vitest';
import type { RouteDeps } from '../types.js';
import {
  planBootRetriggers,
  retriggerInterruptedFinalizeRunsOnBoot,
  type InterruptedFinalizeRun,
  type BootRetriggerStartFn,
} from './boot-retrigger.js';

function run(over: Partial<InterruptedFinalizeRun> & { runId: string }): InterruptedFinalizeRun {
  return {
    sessionId: `sess-${over.runId}`,
    cardId: `card-${over.runId}`,
    projectId: 'proj',
    headSha: `sha-${over.runId}`,
    ...over,
  };
}

describe('planBootRetriggers', () => {
  it('plans one retrigger per interrupted run, dropping none for load', () => {
    const plan = planBootRetriggers({
      interrupted: [run({ runId: 'a' }), run({ runId: 'b' }), run({ runId: 'c' })],
      priorInterruptedCount: () => 1,
      maxGenerations: 3,
    });
    expect(plan.retrigger.map((r) => r.runId)).toEqual(['a', 'b', 'c']);
    expect(plan.skipped).toEqual([]);
  });

  it('dedups multiple interrupted runs for the same session', () => {
    const plan = planBootRetriggers({
      interrupted: [run({ runId: 'a', sessionId: 's' }), run({ runId: 'a2', sessionId: 's' })],
      priorInterruptedCount: () => 1,
      maxGenerations: 3,
    });
    expect(plan.retrigger.map((r) => r.runId)).toEqual(['a']);
    expect(plan.skipped).toEqual([{ sessionId: 's', runId: 'a2', reason: 'duplicate_session' }]);
  });

  it('skips a run that has hit the crash-loop generation cap', () => {
    const plan = planBootRetriggers({
      interrupted: [run({ runId: 'loop' })],
      priorInterruptedCount: () => 3, // == cap
      maxGenerations: 3,
    });
    expect(plan.retrigger).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/crash_loop_cap/);
  });

  it('applies the crash-loop cap per (session, head_sha)', () => {
    const counts: Record<string, number> = { 'sA|shaA': 5, 'sB|shaB': 0 };
    const plan = planBootRetriggers({
      interrupted: [
        run({ runId: 'a', sessionId: 'sA', headSha: 'shaA' }),
        run({ runId: 'b', sessionId: 'sB', headSha: 'shaB' }),
      ],
      priorInterruptedCount: (sid, head) => counts[`${sid}|${head}`] ?? 0,
      maxGenerations: 3,
    });
    expect(plan.retrigger.map((r) => r.runId)).toEqual(['b']);
    expect(plan.skipped.map((s) => s.runId)).toEqual(['a']);
  });

  it('re-triggers a large interrupted set without dropping any (no load cap)', () => {
    const interrupted = Array.from({ length: 25 }, (_, i) => run({ runId: `r${i}` }));
    const plan = planBootRetriggers({
      interrupted,
      priorInterruptedCount: () => 0,
      maxGenerations: 3,
    });
    expect(plan.retrigger).toHaveLength(25);
    expect(plan.skipped).toEqual([]);
  });
});

describe('retriggerInterruptedFinalizeRunsOnBoot', () => {
  function fakeDeps(count: number): RouteDeps {
    return {
      stmts: {
        countInterruptedFinalizeRunsForSessionHead: { get: () => ({ n: count }) },
      },
    } as unknown as RouteDeps;
  }

  it('is a no-op for an empty interrupted set (no kickoff)', async () => {
    const start = vi.fn();
    const res = await retriggerInterruptedFinalizeRunsOnBoot(fakeDeps(0), [], {
      start: start as unknown as BootRetriggerStartFn,
    });
    expect(res).toEqual({ retriggered: 0, skipped: 0 });
    expect(start).not.toHaveBeenCalled();
  });

  it('kicks off one fresh run per planned session and counts successes', async () => {
    const start = vi
      .fn<BootRetriggerStartFn>()
      .mockResolvedValue({ ok: true, runId: 'new-run', status: 'queued' });
    const res = await retriggerInterruptedFinalizeRunsOnBoot(
      fakeDeps(0),
      [run({ runId: 'a' }), run({ runId: 'b' })],
      { start, maxGenerations: 3 },
    );
    expect(start).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ retriggered: 2, skipped: 0 });
  });

  it('does not count a declined kickoff (e.g. ready_to_push) as retriggered', async () => {
    const start = vi
      .fn<BootRetriggerStartFn>()
      .mockResolvedValue({ ok: false, error: 'ready_to_push', runId: 'r' });
    const res = await retriggerInterruptedFinalizeRunsOnBoot(fakeDeps(0), [run({ runId: 'a' })], {
      start,
      maxGenerations: 3,
    });
    expect(res).toEqual({ retriggered: 0, skipped: 0 });
  });

  it('swallows a throwing kickoff and continues to the next session', async () => {
    const start = vi
      .fn<BootRetriggerStartFn>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ ok: true, runId: 'new-run', status: 'queued' });
    const res = await retriggerInterruptedFinalizeRunsOnBoot(
      fakeDeps(0),
      [run({ runId: 'a' }), run({ runId: 'b' })],
      { start, maxGenerations: 3 },
    );
    expect(start).toHaveBeenCalledTimes(2);
    expect(res).toEqual({ retriggered: 1, skipped: 0 });
  });

  it('respects the crash-loop cap via the injected count query', async () => {
    const start = vi.fn<BootRetriggerStartFn>();
    const res = await retriggerInterruptedFinalizeRunsOnBoot(fakeDeps(9), [run({ runId: 'a' })], {
      start,
      maxGenerations: 3,
    });
    expect(start).not.toHaveBeenCalled();
    expect(res).toEqual({ retriggered: 0, skipped: 1 });
  });
});
