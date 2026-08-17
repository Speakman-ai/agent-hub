import { describe, it, expect } from 'vitest';
import {
  createPendingLessonCountsState,
  reconcilePendingLessonProjects,
  beginPendingLessonFetch,
  applyPendingLessonSuccess,
  applyPendingLessonFailure,
  totalPendingLessons,
  pendingLessonCountsSnapshot,
} from './pendingLessonCounts';

/** Convenience: reconcile and return the plain project ids it wants fetched. */
function idsToFetch(...args: Parameters<typeof reconcilePendingLessonProjects>) {
  return reconcilePendingLessonProjects(...args).map((f) => f.projectId);
}

describe('pendingLessonCounts — fetch planning', () => {
  it('seed mode returns every present project on a cold start and marks them in flight', () => {
    const s = createPendingLessonCountsState();
    expect(idsToFetch(s, ['a', 'b'], 'seed')).toEqual(['a', 'b']);
    expect([...s.inFlight].sort()).toEqual(['a', 'b']);
  });

  it('seed mode skips projects already seeded or in flight', () => {
    const s = createPendingLessonCountsState();
    const [a, b] = reconcilePendingLessonProjects(s, ['a', 'b'], 'seed');
    applyPendingLessonSuccess(s, a!.projectId, a!.token, 2); // a now seeded
    applyPendingLessonFailure(s, b!.projectId, b!.token); // b cleared, not seeded
    // a is seeded → skipped; b is neither seeded nor in flight → refetched.
    expect(idsToFetch(s, ['a', 'b'], 'seed')).toEqual(['b']);
  });

  it('refresh mode refetches present projects even when already seeded', () => {
    const s = createPendingLessonCountsState();
    const [a] = reconcilePendingLessonProjects(s, ['a'], 'seed');
    applyPendingLessonSuccess(s, a!.projectId, a!.token, 1);
    expect(idsToFetch(s, ['a'], 'refresh')).toEqual(['a']);
  });

  it('ignores nullish / empty project ids', () => {
    const s = createPendingLessonCountsState();
    expect(idsToFetch(s, ['a', '', null, undefined], 'seed')).toEqual(['a']);
  });

  it('issues a unique, monotonically increasing token per fetch', () => {
    const s = createPendingLessonCountsState();
    const [a, b] = reconcilePendingLessonProjects(s, ['a', 'b'], 'seed');
    const c = beginPendingLessonFetch(s, 'a'); // supersedes a's first token
    const tokens = [a!.token, b!.token, c!.token];
    expect(new Set(tokens).size).toBe(3);
    expect(c!.token).toBeGreaterThan(a!.token);
  });
});

describe('pendingLessonCounts — lifecycle regressions', () => {
  // A project marked seeded on dispatch, then cancelled before its request
  // resolves, must be retried — not stranded blank forever.
  it('retries a project whose fetch was cancelled (failure clears in-flight, not seeded)', () => {
    const s = createPendingLessonCountsState();
    const [a] = reconcilePendingLessonProjects(s, ['a'], 'seed');
    applyPendingLessonFailure(s, a!.projectId, a!.token); // cancelled mid-flight
    expect(idsToFetch(s, ['a'], 'seed')).toEqual(['a']);
    expect(s.seeded.has('a')).toBe(false);
  });

  // A project revisited after an org switch must refetch fresh, not display the
  // stale count it carried before it left the list.
  it('prunes departed projects so a revisit refetches a fresh count', () => {
    const s = createPendingLessonCountsState();
    const [a] = reconcilePendingLessonProjects(s, ['a'], 'seed');
    applyPendingLessonSuccess(s, a!.projectId, a!.token, 5);
    reconcilePendingLessonProjects(s, ['b'], 'seed'); // org switch away from 'a'
    expect(s.counts.a).toBeUndefined();
    expect(s.seeded.has('a')).toBe(false);
    expect(idsToFetch(s, ['a'], 'seed')).toEqual(['a']);
  });

  // A transient failure during a refresh must NOT erase the last known count.
  it('preserves the last successful count when a later refresh fails', () => {
    const s = createPendingLessonCountsState();
    const seeds = reconcilePendingLessonProjects(s, ['a', 'b'], 'seed');
    applyPendingLessonSuccess(s, 'a', seeds[0]!.token, 3);
    applyPendingLessonSuccess(s, 'b', seeds[1]!.token, 2);
    expect(totalPendingLessons(s)).toBe(5);

    const refresh = reconcilePendingLessonProjects(s, ['a', 'b'], 'refresh');
    const aTok = refresh.find((f) => f.projectId === 'a')!.token;
    const bTok = refresh.find((f) => f.projectId === 'b')!.token;
    applyPendingLessonSuccess(s, 'a', aTok, 4);
    applyPendingLessonFailure(s, 'b', bTok);

    expect(s.counts).toEqual({ a: 4, b: 2 }); // b keeps 2, not 0
    expect(totalPendingLessons(s)).toBe(6);
  });

  // Reviewer: overlapping seed + WS refresh can resolve out of order. The older
  // response must NOT overwrite the newer count, regardless of arrival order.
  it('ignores a stale (superseded) completion that resolves after a newer one', () => {
    const s = createPendingLessonCountsState();
    const [seed] = reconcilePendingLessonProjects(s, ['a'], 'seed'); // token T1
    const ws = beginPendingLessonFetch(s, 'a')!; // token T2 supersedes T1

    // Newest (WS) resolves first with the fresh value.
    expect(applyPendingLessonSuccess(s, 'a', ws.token, 7)).toBe(true);
    expect(s.counts.a).toBe(7);

    // The older seed response arrives late — it must be dropped, not applied.
    expect(applyPendingLessonSuccess(s, 'a', seed!.token, 3)).toBe(false);
    expect(s.counts.a).toBe(7);
  });

  it('ignores the newer completion arriving first, then drops the older one too', () => {
    const s = createPendingLessonCountsState();
    const [seed] = reconcilePendingLessonProjects(s, ['a'], 'seed'); // T1
    const ws = beginPendingLessonFetch(s, 'a')!; // T2

    // Stale seed resolves first: current token is T2, so T1 is rejected.
    expect(applyPendingLessonSuccess(s, 'a', seed!.token, 3)).toBe(false);
    expect(s.counts.a).toBeUndefined();
    // WS resolves and wins.
    expect(applyPendingLessonSuccess(s, 'a', ws.token, 7)).toBe(true);
    expect(s.counts.a).toBe(7);
  });

  // Reviewer: a response arriving after its project departed must not re-add it
  // as seeded (which would make a later revisit skip fetching fresh data).
  it('drops a completion that arrives after its project departed mid-flight', () => {
    const s = createPendingLessonCountsState();
    reconcilePendingLessonProjects(s, ['a'], 'seed'); // 'a' present
    const ws = beginPendingLessonFetch(s, 'a')!;
    // Org switch: 'a' leaves the list before the request resolves.
    reconcilePendingLessonProjects(s, ['b'], 'seed');
    // Late response for the departed project is dropped, not re-seeded.
    expect(applyPendingLessonSuccess(s, 'a', ws.token, 9)).toBe(false);
    expect(s.seeded.has('a')).toBe(false);
    expect(s.counts.a).toBeUndefined();
    // Revisiting 'a' therefore refetches instead of trusting stale state.
    expect(idsToFetch(s, ['a'], 'seed')).toEqual(['a']);
  });

  // Reviewer: a WS refresh EVENT that arrives after departure must not even
  // start a fetch — otherwise a fresh token would let its success re-seed the
  // departed project and strand stale data on the next revisit.
  it('refuses a WS refresh for a project that already departed', () => {
    const s = createPendingLessonCountsState();
    const [a] = reconcilePendingLessonProjects(s, ['a', 'b'], 'seed');
    applyPendingLessonSuccess(s, 'a', a!.token, 4);
    // Org switch: only 'b' remains.
    reconcilePendingLessonProjects(s, ['b'], 'seed');

    // A delayed skill_improvement_update for the departed 'a'.
    expect(beginPendingLessonFetch(s, 'a')).toBeNull();
    expect(s.seeded.has('a')).toBe(false);
    expect(s.token.a).toBeUndefined();
    expect(s.counts.a).toBeUndefined();

    // Revisiting 'a' still triggers a fresh seed rather than trusting old state.
    expect(idsToFetch(s, ['a', 'b'], 'seed')).toEqual(['a']);
  });

  it('allows a WS refresh only while the project is present', () => {
    const s = createPendingLessonCountsState();
    reconcilePendingLessonProjects(s, ['a'], 'seed');
    expect(beginPendingLessonFetch(s, 'a')).not.toBeNull(); // present → allowed
    // Never reconciled → not present.
    expect(beginPendingLessonFetch(s, 'ghost')).toBeNull();
  });

  // A stale failure must not clear the in-flight marker owned by a newer fetch.
  it('a superseded failure does not disturb the newer in-flight fetch', () => {
    const s = createPendingLessonCountsState();
    const [seed] = reconcilePendingLessonProjects(s, ['a'], 'seed'); // T1
    const ws = beginPendingLessonFetch(s, 'a')!; // T2, a still in flight
    expect(applyPendingLessonFailure(s, 'a', seed!.token)).toBe(false);
    expect(s.inFlight.has('a')).toBe(true); // T2 still owns the slot
    expect(applyPendingLessonSuccess(s, 'a', ws.token, 4)).toBe(true);
    expect(s.inFlight.has('a')).toBe(false);
  });

  it('normalizes counts: negatives and non-finite become 0, floats floor', () => {
    const s = createPendingLessonCountsState();
    const f = reconcilePendingLessonProjects(s, ['a', 'b', 'c'], 'seed');
    applyPendingLessonSuccess(s, 'a', f[0]!.token, -3);
    applyPendingLessonSuccess(s, 'b', f[1]!.token, 2.9);
    applyPendingLessonSuccess(s, 'c', f[2]!.token, Number.NaN);
    expect(pendingLessonCountsSnapshot(s)).toEqual({ a: 0, b: 2, c: 0 });
  });

  it('snapshot is a copy, not a live reference to internal state', () => {
    const s = createPendingLessonCountsState();
    const [a] = reconcilePendingLessonProjects(s, ['a'], 'seed');
    applyPendingLessonSuccess(s, 'a', a!.token, 1);
    const snap = pendingLessonCountsSnapshot(s);
    const [a2] = reconcilePendingLessonProjects(s, ['a'], 'refresh');
    applyPendingLessonSuccess(s, 'a', a2!.token, 9);
    expect(snap).toEqual({ a: 1 });
  });
});
