import { describe, it, expect, vi, afterEach } from 'vitest';
import { useEffect, useState } from 'react';
import { renderHook, act } from '@testing-library/react';
import { createUseDefaultBranchCi } from '@shared/hooks/useDefaultBranchCi';
import { DEFAULT_BRANCH_CI_POLL_MS } from '@shared/utils/defaultBranchCiStatus';

const useDefaultBranchCi = createUseDefaultBranchCi({ useEffect, useState });

const pushRun = (id: string, status: string) => ({
  runs: [
    {
      id,
      branch: 'main',
      head_sha: `${id}0000000`,
      status,
      trigger_source: 'git_push',
      started_at: 1,
      ended_at: 2,
      jobs: [],
    },
  ],
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const flush = () => act(async () => {});

describe('useDefaultBranchCi', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never starts a poll while the previous request is pending', async () => {
    vi.useFakeTimers();
    const slow = deferred<unknown>();
    const fetchRuns = vi.fn().mockReturnValueOnce(slow.promise);
    renderHook(() => useDefaultBranchCi('p1', true, fetchRuns));
    await flush();
    expect(fetchRuns).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_BRANCH_CI_POLL_MS * 3);
    });
    expect(fetchRuns).toHaveBeenCalledTimes(1);

    fetchRuns.mockResolvedValue(pushRun('b', 'failed'));
    await act(async () => {
      slow.resolve(pushRun('a', 'succeeded'));
    });
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_BRANCH_CI_POLL_MS);
    });
    expect(fetchRuns).toHaveBeenCalledTimes(2);
  });

  it('keeps the newer status when an older request from a previous project settles late', async () => {
    const stale = deferred<unknown>();
    const fetchRuns = vi.fn((projectId: string) =>
      projectId === 'p1' ? stale.promise : Promise.resolve(pushRun('new', 'failed')),
    );
    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useDefaultBranchCi(id, true, fetchRuns),
      { initialProps: { id: 'p1' } },
    );
    rerender({ id: 'p2' });
    await flush();
    expect(result.current?.tone).toBe('failed');

    await act(async () => {
      stale.resolve(pushRun('old', 'succeeded'));
    });
    expect(result.current?.tone).toBe('failed');
    expect(result.current?.sha).toBe('new0000000');
  });

  it('does not fetch when disabled', async () => {
    const fetchRuns = vi.fn();
    const { result } = renderHook(() => useDefaultBranchCi('p1', false, fetchRuns));
    await flush();
    expect(fetchRuns).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });
});
