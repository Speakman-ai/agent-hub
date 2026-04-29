/**
 * Unit tests for `pickRunner` — the pure capability-based selector at
 * the heart of the Phase 3 dispatcher.
 *
 * These tests don't touch the WS layer, the DB, or any I/O: every case
 * builds a `RunnerSnapshot[]` registry by hand and asserts what
 * `pickRunner` returns. That keeps the dispatcher's behaviour pinned
 * down independently of the surrounding wiring (which has its own
 * integration test in runner-e2e.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { pickRunner, type RunnerSnapshot } from './runner-dispatcher.js';

function snap(
  runnerId: string,
  role: RunnerSnapshot['role'],
  extras: Partial<RunnerSnapshot> = {},
): RunnerSnapshot {
  return {
    runnerId,
    role,
    lastUsedAt: null,
    ...extras,
  };
}

describe('pickRunner — empty / no-match cases', () => {
  it('returns null for an empty registry', () => {
    expect(pickRunner({}, [])).toBeNull();
    expect(pickRunner({ role: 'general' }, [])).toBeNull();
    expect(pickRunner({ role: 'pr-preview', pr: 1 }, [])).toBeNull();
  });

  it('returns null when no runner matches the requested role', () => {
    const reg = [snap('r1', 'general'), snap('r2', 'general')];
    expect(pickRunner({ role: 'pr-preview' }, reg)).toBeNull();
    expect(pickRunner({ role: 'scaffold' }, reg)).toBeNull();
  });

  it('returns null when role matches but pr does not', () => {
    const reg = [snap('p685', 'pr-preview', { pr: 685 })];
    expect(pickRunner({ role: 'pr-preview', pr: 999 }, reg)).toBeNull();
  });
});

describe('pickRunner — role + pr exact match', () => {
  it('picks the pr-preview runner with the matching pr over a general runner', () => {
    const reg = [
      snap('general-1', 'general'),
      snap('p685', 'pr-preview', { pr: 685 }),
      snap('general-2', 'general'),
    ];
    expect(pickRunner({ role: 'pr-preview', pr: 685 }, reg)).toBe('p685');
  });

  it('picks the right pr-preview runner when several pr-preview runners are online', () => {
    const reg = [
      snap('p100', 'pr-preview', { pr: 100 }),
      snap('p200', 'pr-preview', { pr: 200 }),
      snap('p300', 'pr-preview', { pr: 300 }),
    ];
    expect(pickRunner({ role: 'pr-preview', pr: 200 }, reg)).toBe('p200');
  });

  it('does NOT cross-route a pr-preview want to a general runner even if no pr-preview is online', () => {
    const reg = [snap('g1', 'general')];
    expect(pickRunner({ role: 'pr-preview', pr: 685 }, reg)).toBeNull();
  });
});

describe('pickRunner — general fallback', () => {
  it('treats want.role === undefined as general', () => {
    const reg = [snap('g1', 'general')];
    expect(pickRunner({}, reg)).toBe('g1');
  });

  it('does NOT route a vague {} want to a pr-preview runner', () => {
    const reg = [snap('p1', 'pr-preview', { pr: 42 })];
    expect(pickRunner({}, reg)).toBeNull();
  });

  it('does NOT route a vague {} want to a scaffold runner', () => {
    const reg = [snap('s1', 'scaffold')];
    expect(pickRunner({}, reg)).toBeNull();
  });
});

describe('pickRunner — round-robin on lastUsedAt', () => {
  it('prefers a never-picked runner over one with a timestamp', () => {
    const reg = [
      snap('r1', 'general', { lastUsedAt: '2026-04-29T00:00:00Z' }),
      snap('r2', 'general'), // null lastUsedAt
      snap('r3', 'general', { lastUsedAt: '2026-04-29T00:01:00Z' }),
    ];
    expect(pickRunner({ role: 'general' }, reg)).toBe('r2');
  });

  it('picks the runner with the oldest lastUsedAt when none are null', () => {
    const reg = [
      snap('newer', 'general', { lastUsedAt: '2026-04-29T00:05:00Z' }),
      snap('oldest', 'general', { lastUsedAt: '2026-04-29T00:01:00Z' }),
      snap('middle', 'general', { lastUsedAt: '2026-04-29T00:03:00Z' }),
    ];
    expect(pickRunner({ role: 'general' }, reg)).toBe('oldest');
  });

  it('rotates picks across multiple calls when the caller stamps lastUsedAt between them', () => {
    // Simulate the WS layer's `markRunnerUsed` by stamping after each pick.
    const reg: RunnerSnapshot[] = [
      snap('a', 'general'),
      snap('b', 'general'),
      snap('c', 'general'),
    ];
    const stamp = (id: string, ts: string): void => {
      const r = reg.find((x) => x.runnerId === id);
      if (r) r.lastUsedAt = ts;
    };

    const p1 = pickRunner({ role: 'general' }, reg)!;
    stamp(p1, '2026-04-29T00:00:01Z');

    const p2 = pickRunner({ role: 'general' }, reg)!;
    stamp(p2, '2026-04-29T00:00:02Z');

    const p3 = pickRunner({ role: 'general' }, reg)!;
    stamp(p3, '2026-04-29T00:00:03Z');

    // All three runners should have been picked exactly once.
    expect(new Set([p1, p2, p3])).toEqual(new Set(['a', 'b', 'c']));

    // The fourth pick should be `p1` again (oldest lastUsedAt now).
    const p4 = pickRunner({ role: 'general' }, reg)!;
    expect(p4).toBe(p1);
  });

  it('breaks ties on runnerId lexicographically when lastUsedAt is identical', () => {
    const reg = [
      snap('zeta', 'general', { lastUsedAt: '2026-04-29T00:00:00Z' }),
      snap('alpha', 'general', { lastUsedAt: '2026-04-29T00:00:00Z' }),
      snap('mu', 'general', { lastUsedAt: '2026-04-29T00:00:00Z' }),
    ];
    expect(pickRunner({ role: 'general' }, reg)).toBe('alpha');
  });

  it('breaks ties on runnerId when both lastUsedAt are null', () => {
    const reg = [snap('zzz', 'general'), snap('aaa', 'general')];
    expect(pickRunner({ role: 'general' }, reg)).toBe('aaa');
  });
});

describe('pickRunner — pure / does not mutate', () => {
  it('does not mutate the registry array passed in', () => {
    const reg = [
      snap('r1', 'general', { lastUsedAt: '2026-04-29T00:05:00Z' }),
      snap('r2', 'general'),
    ];
    const before = JSON.stringify(reg);
    pickRunner({ role: 'general' }, reg);
    const after = JSON.stringify(reg);
    expect(after).toBe(before);
  });

  it('does not mutate the want object passed in', () => {
    const want = { role: 'pr-preview' as const, pr: 685 };
    const before = JSON.stringify(want);
    pickRunner(want, [snap('p685', 'pr-preview', { pr: 685 })]);
    expect(JSON.stringify(want)).toBe(before);
  });
});
