import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api.js';

/**
 * Unit test for `api.resolvePR` — verifies the HTTP request shape against
 * the backend contract documented in `server/routes/pr-resolve.ts`:
 * `POST /api/projects/:projectId/pulls/:number/resolve` with body
 * `{ agentId }` and a `Content-Type: application/json` header.
 */
describe('api.resolvePR', () => {
  let fetchSpy;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function mockJson(body, init = {}) {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
      }),
    );
  }

  it('POSTs to the resolve endpoint with the agentId in the body', async () => {
    fetchSpy.mockReturnValue(
      mockJson(
        { sessionId: 'sess-1', triggered: ['ci'], session: { id: 'sess-1' } },
        { status: 201 },
      ),
    );

    const out = await api.resolvePR('my-project', 42, { agentId: 'agent-x' });

    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/projects\/my-project\/pulls\/42\/resolve$/);
    expect(opts.method).toBe('POST');
    expect(opts.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(opts.body)).toEqual({ agentId: 'agent-x' });
    expect(out).toEqual({
      sessionId: 'sess-1',
      triggered: ['ci'],
      session: { id: 'sess-1' },
    });
  });

  it('returns the no-action-needed shape on a 200 response', async () => {
    fetchSpy.mockReturnValue(
      mockJson({ sessionId: null, triggered: [], reason: 'no-action-needed' }),
    );
    const out = await api.resolvePR('proj', 7, { agentId: 'a' });
    expect(out.sessionId).toBeNull();
    expect(out.triggered).toEqual([]);
  });

  it('throws with the server error message on non-2xx', async () => {
    fetchSpy.mockReturnValue(
      new Response(JSON.stringify({ error: 'agentId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(api.resolvePR('proj', 1, {})).rejects.toThrow(/agentId is required/);
  });
});
