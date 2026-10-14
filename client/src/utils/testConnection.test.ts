/**
 * Regression: in Electron the renderer is served from the embedded localhost
 * server, so a renderer fetch to a remote hub is blocked by CORS and Test
 * Connection showed "Failed to fetch". It must go through the main-process
 * probe when the preload exposes one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('./auth.js', () => ({ getToken: () => null }));

import { testConnection, describeProbeResult } from './connection';

afterEach(() => {
  delete (globalThis as any).window;
  vi.unstubAllGlobals();
});

describe('testConnection', () => {
  it('uses the Electron main-process probe instead of renderer fetch', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchSpy);
    const probe = vi.fn().mockResolvedValue({
      health: { status: 200, statusText: 'OK', data: { agents: 4, uptime: 600 } },
    });
    (globalThis as any).window = { electronAPI: { probeRemoteConnection: probe } };

    const result = await testConnection('https://hub.example.com/ ', ' key ');

    expect(probe).toHaveBeenCalledWith('https://hub.example.com', 'key');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, message: 'Connected — 4 agents, uptime 10m' });
  });

  it('falls back to renderer fetch when the preload has no probe (browser / older desktop)', async () => {
    (globalThis as any).window = {};
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ agents: 1, uptime: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const result = await testConnection('https://hub.example.com', '');

    expect(fetchSpy).toHaveBeenCalledWith('https://hub.example.com/api/health', expect.anything());
    expect(result.ok).toBe(true);
  });
});

describe('describeProbeResult', () => {
  const ok = (data: any) => ({ health: { status: 200, statusText: 'OK', data } });

  it('maps failures to the existing messages', () => {
    expect(describeProbeResult({ error: 'timeout', message: 'x' }, '').message).toBe(
      'Connection timed out after 10 seconds.',
    );
    expect(describeProbeResult({ error: 'network', message: 'fetch failed' }, '').message).toBe(
      'Connection failed: fetch failed',
    );
    expect(
      describeProbeResult({ health: { status: 502, statusText: 'Bad Gateway', data: null } }, '')
        .message,
    ).toBe('Server responded with 502: Bad Gateway');
    expect(describeProbeResult(ok({ authRequired: true }), '').message).toBe(
      'Server requires an API key. Enter one above.',
    );
    expect(
      describeProbeResult(
        ok({ authRequired: true, jwtAuthEnabled: false, apiKeyAuthEnabled: true }),
        '',
      ).message,
    ).toBe('Server requires an API key. Enter one above.');
    expect(
      describeProbeResult(
        { ...ok({ authRequired: true }), auth: { status: 403, statusText: 'Forbidden' } },
        'k',
      ).message,
    ).toBe('Server reachable but API key is invalid (403).');
  });

  it('does not report Connected for a 200 without health data', () => {
    const r = describeProbeResult({ health: { status: 200, statusText: 'OK', data: null } }, 'k');
    expect(r.ok).toBe(false);
  });

  it('lets a JWT hub through without an API key so the user can sign in next', () => {
    const r = describeProbeResult(
      ok({ authRequired: true, jwtAuthEnabled: true, agents: 9, uptime: 120 }),
      '',
    );
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/sign in after connecting/i);
  });

  it('accepts a valid key on an auth-required hub', () => {
    const r = describeProbeResult(
      { ...ok({ authRequired: true, agents: 2 }), auth: { status: 200, statusText: 'OK' } },
      'k',
    );
    expect(r.ok).toBe(true);
  });
});
