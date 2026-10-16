import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, DIGEST_RUN_TIMEOUT_MS } from './api';

describe('api.hubChat.runDigest', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits longer than the server-side generation cap instead of the 15s default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ result: { status: 'posted' }, digest: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.hubChat.runDigest('chan-1', 'dig-1');

    expect(timeoutSpy).toHaveBeenCalledWith(DIGEST_RUN_TIMEOUT_MS);
    expect(DIGEST_RUN_TIMEOUT_MS).toBeGreaterThanOrEqual(180_000);
  });
});
