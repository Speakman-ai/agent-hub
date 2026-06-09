import { describe, it, expect, vi } from 'vitest';
import {
  applyDiffCountWsEffect,
  createDiffFileCountRefresher,
  fileCountFromChangesSummary,
  isWorktreeSession,
  setSessionFileCount,
} from './diffFileCount.js';

/** A promise plus its resolve fn, for controlling resolution order in tests. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('fileCountFromChangesSummary', () => {
  it('counts the files array length', () => {
    expect(fileCountFromChangesSummary({ files: [{ path: 'a' }, { path: 'b' }] })).toBe(2);
  });

  it('returns 0 for an empty files array', () => {
    expect(fileCountFromChangesSummary({ files: [] })).toBe(0);
  });

  it('returns 0 when files is missing', () => {
    expect(fileCountFromChangesSummary({})).toBe(0);
  });

  it('returns 0 when files is not an array', () => {
    expect(fileCountFromChangesSummary({ files: 'nope' })).toBe(0);
    expect(fileCountFromChangesSummary({ files: 3 })).toBe(0);
  });

  it('returns 0 for null/undefined bodies (network error, non-worktree)', () => {
    expect(fileCountFromChangesSummary(null)).toBe(0);
    expect(fileCountFromChangesSummary(undefined)).toBe(0);
  });
});

describe('setSessionFileCount', () => {
  it('adds a new session key', () => {
    const prev = {};
    const next = setSessionFileCount(prev, 's1', 3);
    expect(next).toEqual({ s1: 3 });
    expect(next).not.toBe(prev);
  });

  it('updates an existing changed value with a new reference', () => {
    const prev = { s1: 1, s2: 5 };
    const next = setSessionFileCount(prev, 's1', 4);
    expect(next).toEqual({ s1: 4, s2: 5 });
    expect(next).not.toBe(prev);
  });

  it('returns the same reference when the count is unchanged (React bail-out)', () => {
    const prev = { s1: 2 };
    const next = setSessionFileCount(prev, 's1', 2);
    expect(next).toBe(prev);
  });

  it('treats 0 as a real value, not "unset"', () => {
    const prev = { s1: 3 };
    const next = setSessionFileCount(prev, 's1', 0);
    expect(next).toEqual({ s1: 0 });
    expect(next).not.toBe(prev);
    // and a repeat 0 bails out
    expect(setSessionFileCount(next, 's1', 0)).toBe(next);
  });

  it('returns the same reference when sessionId is missing', () => {
    const prev = { s1: 1 };
    expect(setSessionFileCount(prev, '', 5)).toBe(prev);
    expect(setSessionFileCount(prev, undefined, 5)).toBe(prev);
  });
});

describe('isWorktreeSession', () => {
  it('is true when use_worktree is set', () => {
    expect(isWorktreeSession({ use_worktree: 1 })).toBe(true);
    expect(isWorktreeSession({ use_worktree: true })).toBe(true);
  });

  it('is true when worktree_branch is set', () => {
    expect(isWorktreeSession({ worktree_branch: 'agent-hub/x/session-1' })).toBe(true);
  });

  it('is false for non-worktree / empty / null sessions', () => {
    expect(isWorktreeSession({ use_worktree: 0, worktree_branch: null })).toBe(false);
    expect(isWorktreeSession({})).toBe(false);
    expect(isWorktreeSession(null)).toBe(false);
    expect(isWorktreeSession(undefined)).toBe(false);
  });
});

describe('createDiffFileCountRefresher', () => {
  it('applies the fetched count', async () => {
    const applyCount = vi.fn();
    const refresh = createDiffFileCountRefresher({
      fetchCount: async () => 3,
      applyCount,
    });
    await refresh('s1');
    expect(applyCount).toHaveBeenCalledExactlyOnceWith('s1', 3);
  });

  it('does nothing without a sessionId', async () => {
    const fetchCount = vi.fn();
    const applyCount = vi.fn();
    const refresh = createDiffFileCountRefresher({ fetchCount, applyCount });
    await refresh('');
    await refresh(undefined);
    expect(fetchCount).not.toHaveBeenCalled();
    expect(applyCount).not.toHaveBeenCalled();
  });

  it('skips applying when fetchCount returns null/undefined', async () => {
    const applyCount = vi.fn();
    const refreshNull = createDiffFileCountRefresher({ fetchCount: async () => null, applyCount });
    await refreshNull('s1');
    const refreshUndef = createDiffFileCountRefresher({
      fetchCount: async () => undefined,
      applyCount,
    });
    await refreshUndef('s1');
    expect(applyCount).not.toHaveBeenCalled();
  });

  it('swallows fetch rejection and keeps the last known count', async () => {
    const applyCount = vi.fn();
    const refresh = createDiffFileCountRefresher({
      fetchCount: async () => {
        throw new Error('network down');
      },
      applyCount,
    });
    await expect(refresh('s1')).resolves.toBeUndefined();
    expect(applyCount).not.toHaveBeenCalled();
  });

  it('discards a stale earlier response that resolves AFTER a newer one', async () => {
    // Reproduces the reviewer scenario: an earlier request returns a lower
    // (stale) count after a later request already stored the final tally.
    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1, d2];
    let i = 0;
    const applied = [];
    const refresh = createDiffFileCountRefresher({
      fetchCount: () => calls[i++].promise,
      applyCount: (sid, count) => applied.push([sid, count]),
    });
    const p1 = refresh('s1'); // seq 1 (earlier)
    const p2 = refresh('s1'); // seq 2 (newer — final tally)
    d2.resolve(5); // newer resolves first → applied
    await p2;
    d1.resolve(2); // stale earlier resolves later → must be ignored
    await p1;
    expect(applied).toEqual([['s1', 5]]);
  });

  it('shows the older valid result promptly, then supersedes with the newer one', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1, d2];
    let i = 0;
    const applied = [];
    const refresh = createDiffFileCountRefresher({
      fetchCount: () => calls[i++].promise,
      applyCount: (sid, count) => applied.push([sid, count]),
    });
    const p1 = refresh('s1'); // seq 1
    const p2 = refresh('s1'); // seq 2
    d1.resolve(2); // older resolves first → applied (best available so far)
    await p1;
    d2.resolve(5); // newer → supersedes
    await p2;
    expect(applied).toEqual([
      ['s1', 2],
      ['s1', 5],
    ]);
  });

  it('keeps an older VALID result when the newer request fails (no stale strand)', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1, d2];
    let i = 0;
    const applied = [];
    const refresh = createDiffFileCountRefresher({
      fetchCount: () => calls[i++].promise,
      applyCount: (sid, count) => applied.push([sid, count]),
    });
    const p1 = refresh('s1'); // seq 1 (valid)
    const p2 = refresh('s1'); // seq 2 (newer, will fail)
    d2.reject(new Error('transient 500')); // newer fails first → must NOT advance the guard
    await p2.catch(() => {});
    d1.resolve(3); // older valid result still applies
    await p1;
    expect(applied).toEqual([['s1', 3]]);
  });

  it('keeps an older VALID result when the newer request returns null', async () => {
    const d1 = deferred();
    const d2 = deferred();
    const calls = [d1, d2];
    let i = 0;
    const applied = [];
    const refresh = createDiffFileCountRefresher({
      fetchCount: () => calls[i++].promise,
      applyCount: (sid, count) => applied.push([sid, count]),
    });
    const p1 = refresh('s1'); // seq 1 (valid)
    const p2 = refresh('s1'); // seq 2 (newer, returns null)
    d2.resolve(null); // newer non-applyable → must NOT advance the guard
    await p2;
    d1.resolve(4); // older valid result still applies
    await p1;
    expect(applied).toEqual([['s1', 4]]);
  });

  it('tracks sequences independently per session', async () => {
    const applied = [];
    const refresh = createDiffFileCountRefresher({
      fetchCount: async (sid) => (sid === 's1' ? 1 : 9),
      applyCount: (sid, count) => applied.push([sid, count]),
    });
    await refresh('s1');
    await refresh('s2');
    expect(applied).toEqual([
      ['s1', 1],
      ['s2', 9],
    ]);
  });
});

describe('applyDiffCountWsEffect', () => {
  const worktreeSession = { id: 's1', use_worktree: 1 };
  const plainSession = { id: 's2', use_worktree: 0 };

  function harness(sessions) {
    const refresh = vi.fn();
    const bumpReloadToken = vi.fn();
    return {
      refresh,
      bumpReloadToken,
      run: (event) => applyDiffCountWsEffect(event, { sessions, refresh, bumpReloadToken }),
    };
  }

  it('refreshes the badge AND bumps the pane on code_changed for a known session', () => {
    const h = harness([worktreeSession]);
    expect(h.run({ type: 'code_changed', sessionId: 's1' })).toBe(true);
    expect(h.refresh).toHaveBeenCalledExactlyOnceWith('s1');
    expect(h.bumpReloadToken).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('re-tallies on done for a worktree session', () => {
    const h = harness([worktreeSession]);
    expect(h.run({ type: 'done', sessionId: 's1' })).toBe(true);
    expect(h.refresh).toHaveBeenCalledExactlyOnceWith('s1');
    expect(h.bumpReloadToken).toHaveBeenCalledExactlyOnceWith('s1');
  });

  it('does NOT recount on done for a non-worktree session', () => {
    const h = harness([plainSession]);
    expect(h.run({ type: 'done', sessionId: 's2' })).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.bumpReloadToken).not.toHaveBeenCalled();
  });

  it('ignores events for sessions not in the list', () => {
    const h = harness([worktreeSession]);
    expect(h.run({ type: 'code_changed', sessionId: 'unknown' })).toBe(false);
    expect(h.run({ type: 'done', sessionId: 'unknown' })).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.bumpReloadToken).not.toHaveBeenCalled();
  });

  it('ignores unrelated event types', () => {
    const h = harness([worktreeSession]);
    expect(h.run({ type: 'message', sessionId: 's1' })).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('is a no-op for missing/empty events', () => {
    const h = harness([worktreeSession]);
    expect(h.run(null)).toBe(false);
    expect(h.run({})).toBe(false);
    expect(h.run({ type: 'done' })).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
