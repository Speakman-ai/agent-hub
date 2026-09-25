import { describe, it, expect, vi } from 'vitest';
import { coalesceRefreshByKey, type PendingRefresh } from './coalesceRefresh';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('coalesceRefreshByKey', () => {
  it('collapses a burst into a trailing refresh and retains updates during that refresh', async () => {
    const map = { current: new Map<string, PendingRefresh>() };
    const first = deferred();
    const second = deferred();
    const refresh = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValue(undefined);
    const result = coalesceRefreshByKey(map, 'project', refresh);
    for (let i = 0; i < 50; i++) {
      expect(coalesceRefreshByKey(map, 'project', refresh)).toBe(result);
    }
    expect(refresh).toHaveBeenCalledTimes(1);
    first.resolve();
    await first.promise;
    expect(refresh).toHaveBeenCalledTimes(2);
    coalesceRefreshByKey(map, 'project', refresh);
    second.resolve();
    await result;
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(map.current.size).toBe(0);
  });

  it('refreshes different projects independently', async () => {
    const map = { current: new Map<string, PendingRefresh>() };
    const first = deferred();
    const a = coalesceRefreshByKey(map, 'a', () => first.promise);
    const refreshB = vi.fn().mockResolvedValue(undefined);
    await coalesceRefreshByKey(map, 'b', refreshB);
    expect(refreshB).toHaveBeenCalledOnce();
    expect(map.current.has('a')).toBe(true);
    first.resolve();
    await a;
  });

  it('releases a failed request so later updates can retry', async () => {
    const map = { current: new Map<string, PendingRefresh>() };
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    await expect(coalesceRefreshByKey(map, 'project', refresh)).rejects.toThrow('offline');
    expect(map.current.size).toBe(0);
    await coalesceRefreshByKey(map, 'project', refresh);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
