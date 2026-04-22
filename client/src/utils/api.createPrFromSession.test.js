import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api.js';

describe('api.createPrFromSession', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does not attach an AbortSignal timeout so long-running publish can finish', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ prUrl: 'https://gh/pr/1', cardId: 'c1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.createPrFromSession('sess-9', { autoMerge: true });

    const [, opts] = fetchSpy.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.signal).toBeUndefined();
    expect(JSON.parse(opts.body)).toEqual({ autoMerge: true, title: undefined });
  });
});
