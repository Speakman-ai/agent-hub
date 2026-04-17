import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from './api.js';

/**
 * Smoke tests for the ClawHub API helpers.
 *
 * These verify that each helper hits the right URL on the /api/clawhub
 * proxy and that `clawhubInstall` surfaces `stderrTail` from a 500
 * response on the thrown error (the generic fetchJSON would strip it).
 */
describe('ClawHub API helpers', () => {
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
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        ...init,
      }),
    );
  }

  it('clawhubSearch builds the correct URL with query and limit', async () => {
    fetchSpy.mockReturnValue(mockJson([]));
    await api.clawhubSearch('postgres', 25);

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/clawhub\/search\?/);
    expect(url).toContain('q=postgres');
    expect(url).toContain('limit=25');
  });

  it('clawhubListSkills omits the query string when no limit is given', async () => {
    fetchSpy.mockReturnValue(mockJson([]));
    await api.clawhubListSkills();

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/clawhub\/skills$/);
  });

  it('clawhubGetVersions URL-encodes the slug', async () => {
    fetchSpy.mockReturnValue(mockJson([]));
    await api.clawhubGetVersions('weird/slug');

    const [url] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/\/clawhub\/skills\/weird%2Fslug\/versions$/);
  });

  it('clawhubInstall posts the right body and returns the parsed response', async () => {
    fetchSpy.mockReturnValue(mockJson({ slug: 's', installedAt: '2026-04-17', path: '/p' }));
    const out = await api.clawhubInstall({
      slug: 's',
      version: '1.0.0',
      target: 'agent',
      agentId: 'a',
    });

    const [, init] = fetchSpy.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      slug: 's',
      version: '1.0.0',
      target: 'agent',
      agentId: 'a',
    });
    expect(out.slug).toBe('s');
  });

  it('clawhubInstall surfaces stderrTail and status on a 500 error', async () => {
    fetchSpy.mockReturnValue(
      mockJson(
        { error: 'clawhub install failed (exit 1)', stderrTail: 'npm ERR! 404 Not Found' },
        { status: 500 },
      ),
    );

    await expect(api.clawhubInstall({ slug: 'broken', target: 'global' })).rejects.toMatchObject({
      message: expect.stringContaining('clawhub install failed'),
      stderrTail: 'npm ERR! 404 Not Found',
      status: 500,
    });
  });
});
