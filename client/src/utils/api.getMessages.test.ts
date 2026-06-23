import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api';

/**
 * Unit test for `api.getMessages` — covers the legacy full-transcript fetch
 * and the reverse-infinite-scroll paginated fetch shapes against the backend
 * contract in `server/routes/sessions.ts` (`?paginated=1&limit=&before=`).
 * It must always resolve to a plain array (the envelope/truncation forms are
 * normalized away) so existing callers keep working.
 */
describe('api.getMessages', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockJson(body: any, init: any = {}) {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
      }),
    );
  }

  function lastUrl() {
    return new URL((fetchSpy as any).mock.calls[0][0], 'http://x');
  }

  it('fetches the full transcript with no query params when given no opts', async () => {
    (fetchSpy as any).mockReturnValue(mockJson([{ id: 'm1' }]));
    const out = await api.getMessages('sess-1');
    const url = lastUrl();
    expect(url.pathname).toMatch(/\/sessions\/sess-1\/messages$/);
    expect(url.search).toBe('');
    expect(out!).toEqual([{ id: 'm1' }]);
  });

  it('requests the newest page with paginated=1 + limit when given a limit', async () => {
    (fetchSpy as any).mockReturnValue(mockJson([{ id: 'm1' }, { id: 'm2' }]));
    const out = await api.getMessages('sess-1', { limit: 40 });
    const url = lastUrl();
    expect(url.searchParams.get('paginated')).toBe('1');
    expect(url.searchParams.get('limit')).toBe('40');
    expect(url.searchParams.has('before')).toBe(false);
    expect(out!).toEqual([{ id: 'm1' }, { id: 'm2' }]);
  });

  it('passes the before message id when fetching an older page', async () => {
    (fetchSpy as any).mockReturnValue(mockJson([]));
    await api.getMessages('sess-1', { limit: 40, before: 'm-oldest' });
    const url = lastUrl();
    expect(url.searchParams.get('before')).toBe('m-oldest');
    expect(url.searchParams.get('paginated')).toBe('1');
  });

  it('normalizes a truncation envelope down to its messages array', async () => {
    (fetchSpy as any).mockReturnValue(
      mockJson({ messages: [{ id: 'm9' }], truncated: true, omitted: 3, total: 4 }),
    );
    const out = await api.getMessages('sess-1');
    expect(out!).toEqual([{ id: 'm9' }]);
  });
});
