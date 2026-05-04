/**
 * Unit tests for NangoAdapter. Each test injects its own fetch mock
 * (via the `fetchImpl` constructor option) so we don't have to swap
 * `globalThis.fetch` and remember to restore it.
 */

import { describe, it, expect, vi } from 'vitest';
import { NangoAdapter } from './nango-adapter.js';
import { IntegrationProviderError } from './provider.js';

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function makeFetchMock(handler: (call: CapturedCall) => Response): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const call: CapturedCall = { url, init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fetch: mock, calls };
}

describe('NangoAdapter.createConnection', () => {
  const cfg = {
    hubInstanceId: 'hub-uuid-1',
    userId: 'user-uuid-2',
    app: 'slack',
  };
  const expectedEndUserId = 'hub-uuid-1:user-uuid-2';

  it('forwards end_user.id and tags, returns connect_link as authUrl', async () => {
    const { fetch, calls } = makeFetchMock(() => {
      return new Response(
        JSON.stringify({
          data: {
            token: 'sess-token-xyz',
            connect_link: 'https://app.nango.dev/connect/sess-token-xyz',
            expires_at: '2026-05-04T12:00:00Z',
          },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    });

    const adapter = new NangoAdapter({
      baseUrl: 'https://api.nango.dev',
      secretKey: 'sk_test',
      fetchImpl: fetch,
    });
    const out = await adapter.createConnection(cfg);

    expect(out).toEqual({
      authUrl: 'https://app.nango.dev/connect/sess-token-xyz',
      connectionId: 'sess-token-xyz',
      endUserId: expectedEndUserId,
    });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.nango.dev/connect/sessions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk_test');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      allowed_integrations: ['slack'],
      end_user: { id: expectedEndUserId },
      tags: { end_user_id: expectedEndUserId },
    });
  });

  it('strips trailing slashes from baseUrl', async () => {
    const { fetch, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ data: { token: 't', connect_link: 'https://x' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({
      baseUrl: 'https://api.nango.dev///',
      secretKey: 'sk',
      fetchImpl: fetch,
    });
    await adapter.createConnection(cfg);
    expect(calls[0]!.url).toBe('https://api.nango.dev/connect/sessions');
  });

  it('maps a 4xx error to IntegrationProviderError with status + body', async () => {
    const { fetch } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ error: 'invalid_integration' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({
      secretKey: 'sk',
      fetchImpl: fetch,
    });

    await expect(adapter.createConnection(cfg)).rejects.toMatchObject({
      name: 'IntegrationProviderError',
      status: 400,
    });
    try {
      await adapter.createConnection(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(IntegrationProviderError);
      expect((err as IntegrationProviderError).body).toContain('invalid_integration');
    }
  });

  it('throws when connect_link is missing from a 200 response', async () => {
    const { fetch } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ data: { token: 't' } }), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(adapter.createConnection(cfg)).rejects.toThrow(/connect_link/);
  });

  it('rejects when hubInstanceId or userId is empty', async () => {
    const { fetch } = makeFetchMock(() => new Response('', { status: 200 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(
      adapter.createConnection({ hubInstanceId: '', userId: 'u', app: 'slack' }),
    ).rejects.toThrow(/hubInstanceId/);
    await expect(
      adapter.createConnection({ hubInstanceId: 'h', userId: '', app: 'slack' }),
    ).rejects.toThrow(/userId/);
  });
});

describe('NangoAdapter.listConnections', () => {
  it('filters by end_user_id prefix and drops other tenants', async () => {
    // Mixed-tenant payload: two of these belong to hub-A:user-1, the
    // others belong to other (hub, user) pairs. The adapter must drop
    // the foreign rows even though the deprecated query param "should"
    // have already filtered them.
    const payload = {
      connections: [
        {
          connection_id: 'conn-1',
          provider_config_key: 'slack',
          created: '2026-05-01T00:00:00Z',
          end_user: { id: 'hub-A:user-1' },
          metadata: { team: 'eng' },
        },
        {
          connection_id: 'conn-2',
          provider_config_key: 'google-mail',
          created: '2026-05-02T00:00:00Z',
          end_user: { id: 'hub-A:user-1' },
          metadata: null,
        },
        {
          connection_id: 'conn-3',
          provider_config_key: 'slack',
          created: '2026-05-03T00:00:00Z',
          end_user: { id: 'hub-A:user-2' }, // same hub, different user
        },
        {
          connection_id: 'conn-4',
          provider_config_key: 'slack',
          created: '2026-05-04T00:00:00Z',
          end_user: { id: 'hub-B:user-1' }, // foreign hub
        },
        {
          // Tag-only row (forward-compat path) — should still match.
          connection_id: 'conn-5',
          provider_config_key: 'notion',
          created: '2026-05-05T00:00:00Z',
          end_user: null,
          tags: { end_user_id: 'hub-A:user-1' },
        },
        {
          // Row with no identifying info — must be dropped, not leaked.
          connection_id: 'conn-orphan',
          provider_config_key: 'github',
          created: '2026-05-05T00:00:00Z',
          end_user: null,
        },
      ],
    };
    const { fetch, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    const out = await adapter.listConnections({ hubInstanceId: 'hub-A', userId: 'user-1' });

    expect(out.map((c) => c.connectionId)).toEqual(['conn-1', 'conn-2', 'conn-5']);
    expect(out[0]).toEqual({
      connectionId: 'conn-1',
      app: 'slack',
      createdAt: '2026-05-01T00:00:00Z',
      endUserId: 'hub-A:user-1',
      metadata: { team: 'eng' },
    });

    // The adapter forwards both the legacy and the tag filter so Nango
    // can apply server-side filtering when available.
    expect(calls[0]!.url).toContain('endUserId=hub-A%3Auser-1');
    expect(calls[0]!.url).toContain('tags%5Bend_user_id%5D=hub-A%3Auser-1');
  });

  it('client-side filter excludes a different hub even if the prefix overlaps', async () => {
    // hub-A is a prefix of hub-AA — make sure the colon delimiter
    // prevents a false positive.
    const payload = {
      connections: [
        { connection_id: 'good', provider_config_key: 'slack', end_user: { id: 'hub-A:user-1' } },
        { connection_id: 'bad', provider_config_key: 'slack', end_user: { id: 'hub-AA:user-1' } },
      ],
    };
    const { fetch } = makeFetchMock(
      () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    const out = await adapter.listConnections({ hubInstanceId: 'hub-A', userId: 'user-1' });
    expect(out.map((c) => c.connectionId)).toEqual(['good']);
  });

  it('returns [] for an empty Nango response', async () => {
    const { fetch } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ connections: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    const out = await adapter.listConnections({ hubInstanceId: 'hub-A', userId: 'user-1' });
    expect(out).toEqual([]);
  });

  it('maps a 5xx error to IntegrationProviderError', async () => {
    const { fetch } = makeFetchMock(() => new Response('upstream down', { status: 502 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(
      adapter.listConnections({ hubInstanceId: 'hub-A', userId: 'user-1' }),
    ).rejects.toMatchObject({
      name: 'IntegrationProviderError',
      status: 502,
    });
  });
});

describe('NangoAdapter.proxyCall', () => {
  it('forwards Connection-Id + Provider-Config-Key + Bearer auth on 200', async () => {
    const { fetch, calls } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ ok: true, channel: { id: 'C1' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    const result = await adapter.proxyCall({
      connectionId: 'conn-1',
      app: 'slack',
      path: 'chat.postMessage',
      opts: {
        method: 'POST',
        body: { channel: 'C1', text: 'hi' },
        headers: { 'X-Trace-Id': 'trace-123' },
      },
    });

    expect(result).toEqual({ ok: true, channel: { id: 'C1' } });
    const { url, init } = calls[0]!;
    expect(url).toBe('https://api.nango.dev/proxy/chat.postMessage');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk');
    expect(headers['Connection-Id']).toBe('conn-1');
    expect(headers['Provider-Config-Key']).toBe('slack');
    expect(headers['X-Trace-Id']).toBe('trace-123');
    expect(JSON.parse(init.body as string)).toEqual({ channel: 'C1', text: 'hi' });
  });

  it('strips a leading slash from path so /proxy/ is not doubled', async () => {
    const { fetch, calls } = makeFetchMock(
      () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await adapter.proxyCall({
      connectionId: 'c',
      app: 'slack',
      path: '/users.info',
      opts: { method: 'GET' },
    });
    expect(calls[0]!.url).toBe('https://api.nango.dev/proxy/users.info');
  });

  it('maps 401 to IntegrationProviderError with status preserved', async () => {
    const { fetch } = makeFetchMock(
      () =>
        new Response(JSON.stringify({ error: 'invalid_auth' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(
      adapter.proxyCall({
        connectionId: 'c',
        app: 'slack',
        path: 'chat.postMessage',
        opts: { method: 'POST', body: {} },
      }),
    ).rejects.toMatchObject({
      name: 'IntegrationProviderError',
      status: 401,
    });
  });

  it('appends query params and defaults method to GET', async () => {
    const { fetch, calls } = makeFetchMock(
      () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await adapter.proxyCall({
      connectionId: 'c',
      app: 'slack',
      path: 'users.list',
      opts: { query: { limit: 50, presence: true, undef: undefined } },
    });
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.url).toContain('limit=50');
    expect(calls[0]!.url).toContain('presence=true');
    expect(calls[0]!.url).not.toContain('undef=');
  });
});

describe('NangoAdapter.deleteConnection', () => {
  it('treats 204 as success', async () => {
    const { fetch, calls } = makeFetchMock(() => new Response(null, { status: 204 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(adapter.deleteConnection('conn-1')).resolves.toBeUndefined();
    expect(calls[0]!.url).toBe('https://api.nango.dev/connection/conn-1');
    expect(calls[0]!.init.method).toBe('DELETE');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk');
  });

  it('treats 404 as success (idempotent)', async () => {
    const { fetch } = makeFetchMock(() => new Response('{}', { status: 404 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(adapter.deleteConnection('already-gone')).resolves.toBeUndefined();
  });

  it('maps 500 to IntegrationProviderError', async () => {
    const { fetch } = makeFetchMock(() => new Response('boom', { status: 500 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(adapter.deleteConnection('c')).rejects.toMatchObject({
      name: 'IntegrationProviderError',
      status: 500,
    });
  });

  it('rejects empty connectionId without making a fetch call', async () => {
    const { fetch, calls } = makeFetchMock(() => new Response(null, { status: 204 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await expect(adapter.deleteConnection('')).rejects.toThrow(/connectionId/);
    expect(calls).toHaveLength(0);
  });

  it('URL-encodes the connection id', async () => {
    const { fetch, calls } = makeFetchMock(() => new Response(null, { status: 204 }));
    const adapter = new NangoAdapter({ secretKey: 'sk', fetchImpl: fetch });
    await adapter.deleteConnection('weird/id with space');
    expect(calls[0]!.url).toBe('https://api.nango.dev/connection/weird%2Fid%20with%20space');
  });
});
