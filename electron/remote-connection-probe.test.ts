import { describe, it, expect, vi } from 'vitest';
import { normalizeRemoteBase, probeRemoteConnection } from './remote-connection-probe.js';

function json(body: unknown, status = 200, statusText = 'OK') {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

describe('normalizeRemoteBase', () => {
  it('strips trailing slashes and keeps a path prefix', () => {
    expect(normalizeRemoteBase(' https://hub.example.com/ ')).toBe('https://hub.example.com');
    expect(normalizeRemoteBase('https://hub.example.com/hub/')).toBe('https://hub.example.com/hub');
  });

  it('rejects non-http schemes, credentials, and junk', () => {
    expect(normalizeRemoteBase('file:///etc/passwd')).toBeNull();
    expect(normalizeRemoteBase('https://u:p@hub.example.com')).toBeNull();
    expect(normalizeRemoteBase('not a url')).toBeNull();
    expect(normalizeRemoteBase(42)).toBeNull();
  });
});

describe('probeRemoteConnection', () => {
  it('returns health data for an open hub without an auth call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ authRequired: false, agents: 3 }));
    const result = await probeRemoteConnection('https://hub.example.com/', '', fetchImpl);
    expect(result).toEqual({
      health: { status: 200, statusText: 'OK', data: { authRequired: false, agents: 3 } },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://hub.example.com/api/health');
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('X-API-Key');
  });

  it('checks the API key against /api/agents without following redirects', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ authRequired: true }))
      .mockResolvedValueOnce(new Response('', { status: 401, statusText: 'Unauthorized' }));
    const result = await probeRemoteConnection('https://hub.example.com', ' k1 ', fetchImpl);
    expect(result).toMatchObject({ auth: { status: 401 } });
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe('https://hub.example.com/api/agents');
    expect(init.headers['X-API-Key']).toBe('k1');
    expect(init.redirect).toBe('error');
  });

  it('reports a non-2xx health status without parsing the body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>', { status: 502, statusText: 'Bad Gateway' }));
    const result = await probeRemoteConnection('https://hub.example.com', 'k', fetchImpl);
    expect(result).toEqual({ health: { status: 502, statusText: 'Bad Gateway', data: null } });
  });

  it('maps network failures and timeouts', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: { message: 'getaddrinfo ENOTFOUND hub.example.com' },
    });
    expect(
      await probeRemoteConnection('https://hub.example.com', '', vi.fn().mockRejectedValue(netErr)),
    ).toEqual({
      error: 'network',
      message: 'fetch failed (getaddrinfo ENOTFOUND hub.example.com)',
    });
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    expect(
      await probeRemoteConnection(
        'https://hub.example.com',
        '',
        vi.fn().mockRejectedValue(timeout),
      ),
    ).toMatchObject({ error: 'timeout' });
  });

  it('fails on a 200 health response that is not JSON', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>login</html>', { status: 200, statusText: 'OK' }));
    const result = await probeRemoteConnection('https://hub.example.com', 'k', fetchImpl);
    expect(result).toMatchObject({ error: 'network' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout while reading the health body', async () => {
    const res = new Response('{}', { status: 200 });
    vi.spyOn(res, 'json').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    const result = await probeRemoteConnection(
      'https://hub.example.com',
      '',
      vi.fn().mockResolvedValue(res),
    );
    expect(result).toMatchObject({ error: 'timeout' });
  });

  it('does not fetch an invalid URL', async () => {
    const fetchImpl = vi.fn();
    expect(await probeRemoteConnection('ftp://x', '', fetchImpl)).toMatchObject({
      error: 'invalid-url',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
