import { describe, it, expect, vi } from 'vitest';
import { contextBarSegments, formatTokenCount, startLatestOnlyPolling } from './contextUsage';

describe('formatTokenCount', () => {
  it('formats like the engine context meters', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(950)).toBe('950');
    expect(formatTokenCount(1700)).toBe('1.7K');
    expect(formatTokenCount(157_480)).toBe('157K');
    expect(formatTokenCount(57_480)).toBe('57.5K');
    expect(formatTokenCount(256_000)).toBe('256K');
    expect(formatTokenCount(1_000_000)).toBe('1M');
  });
});

describe('contextBarSegments', () => {
  it('scales against the window and drops empty categories', () => {
    expect(
      contextBarSegments(
        [
          { key: 'system', tokens: 1000 },
          { key: 'skills', tokens: 0 },
          { key: 'conversation', tokens: 9000 },
        ],
        100_000,
      ),
    ).toEqual([
      { key: 'system', widthPct: 1 },
      { key: 'conversation', widthPct: 9 },
    ]);
  });

  it('fills the bar when the window is unknown', () => {
    const segs = contextBarSegments([{ key: 'conversation', tokens: 50 }], null);
    expect(segs).toEqual([{ key: 'conversation', widthPct: 100 }]);
  });
});

describe('startLatestOnlyPolling', () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
  }

  it('drops a slow older response that lands after a newer one', async () => {
    vi.useFakeTimers();
    const pending = [deferred<string>(), deferred<string>()];
    let call = 0;
    const onData = vi.fn();
    const stop = startLatestOnlyPolling({
      fetchUsage: () => pending[call++].promise,
      onData,
      onError: () => {},
      intervalMs: 1000,
    });
    vi.advanceTimersByTime(1000);
    pending[1].resolve('new');
    await Promise.resolve();
    pending[0].resolve('old');
    await Promise.resolve();
    expect(onData.mock.calls).toEqual([['new']]);
    stop();
    vi.useRealTimers();
  });

  it('applies nothing after stop', async () => {
    const d = deferred<string>();
    const onData = vi.fn();
    const stop = startLatestOnlyPolling({
      fetchUsage: () => d.promise,
      onData,
      onError: () => {},
      intervalMs: 60_000,
    });
    stop();
    d.resolve('late');
    await Promise.resolve();
    expect(onData).not.toHaveBeenCalled();
  });
});
