import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, FULL_BOARD_TIMEOUT_MS } from './api';

function okBoard() {
  return new Response(JSON.stringify({ cards: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api.getBoard timeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives the full-board read longer than the 15s default', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okBoard());

    await api.getBoard('p1', { limit: 'all' });

    expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/projects\/p1\/board\?limit=all$/);
    expect(timeoutSpy).toHaveBeenCalledWith(FULL_BOARD_TIMEOUT_MS);
    expect(FULL_BOARD_TIMEOUT_MS).toBeGreaterThan(15_000);
  });

  it('keeps the default timeout for the paged board', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okBoard());

    await api.getBoard('p1');

    expect(timeoutSpy).toHaveBeenCalledWith(15000);
  });
});
