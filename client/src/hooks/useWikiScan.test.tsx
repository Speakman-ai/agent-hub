import { describe, it, expect, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { startWikiScan, useWikiScan, type WikiScanStarted } from './useWikiScan';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startWikiScan', () => {
  it('POSTs to the scan route and returns the session', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessionId: 's1', agentId: 'docs', reused: false }), {
        status: 201,
      }),
    );
    const out = await startWikiScan('/api', 'proj', fetchImpl as unknown as typeof fetch);
    expect(out).toEqual({ sessionId: 's1', agentId: 'docs', reused: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/projects/proj/wiki/scan');
    expect(init.method).toBe('POST');
  });

  it("throws the server's error message on failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ error: 'No docs agent' }), { status: 404 }));
    await expect(
      startWikiScan('/api', 'proj', fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow('No docs agent');
  });
});

describe('useWikiScan', () => {
  it("drops project A's scan response after switching to project B", async () => {
    const pending = deferred<WikiScanStarted>();
    const start = vi.fn().mockReturnValue(pending.promise);
    const showToast = vi.fn();
    const { result, rerender } = renderHook(
      ({ projectId }) => useWikiScan('/api', projectId, showToast, start),
      { initialProps: { projectId: 'a' } },
    );

    let scanPromise!: Promise<void>;
    act(() => {
      scanPromise = result.current.startScan();
    });
    expect(result.current.starting).toBe(true);

    rerender({ projectId: 'b' });
    expect(result.current.starting).toBe(false);

    await act(async () => {
      pending.resolve({ sessionId: 's-a', agentId: 'docs', reused: false });
      await scanPromise;
    });
    expect(result.current.scan).toBeNull();
    expect(result.current.starting).toBe(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it("drops project A's scan error after switching to project B", async () => {
    const pending = deferred<WikiScanStarted>();
    const start = vi.fn().mockReturnValue(pending.promise);
    const { result, rerender } = renderHook(
      ({ projectId }) => useWikiScan('/api', projectId, undefined, start),
      { initialProps: { projectId: 'a' } },
    );
    let scanPromise!: Promise<void>;
    act(() => {
      scanPromise = result.current.startScan();
    });
    rerender({ projectId: 'b' });
    await act(async () => {
      pending.reject(new Error('boom'));
      await scanPromise;
    });
    expect(result.current.error).toBeNull();
  });

  it('shows the scan when the project is unchanged', async () => {
    const start = vi.fn().mockResolvedValue({ sessionId: 's1', agentId: 'docs', reused: true });
    const showToast = vi.fn();
    const { result } = renderHook(() => useWikiScan('/api', 'a', showToast, start));
    await act(async () => {
      await result.current.startScan();
    });
    expect(result.current.scan).toMatchObject({ sessionId: 's1' });
    expect(result.current.starting).toBe(false);
    expect(showToast).toHaveBeenCalledWith('A wiki scan is already running', 'success');
  });
});
