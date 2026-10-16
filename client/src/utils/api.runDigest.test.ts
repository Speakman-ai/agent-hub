import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, DIGEST_RUN_TIMEOUT_MS } from './api';

describe('api.hubChat.runDigest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits far longer than the 15s default for the digest generation', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'posted' }, digest: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.hubChat.runDigest('chan-1', 'dig-1');

    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/chat\/channels\/chan-1\/digests\/dig-1\/run$/);
    expect(opts.method).toBe('POST');
    expect(timeoutSpy).toHaveBeenCalledWith(DIGEST_RUN_TIMEOUT_MS);
    expect(DIGEST_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});
