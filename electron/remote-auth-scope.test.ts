import { describe, expect, it } from 'vitest';
import {
  authRecordFromIpc,
  remoteAuthHeaders,
  requestOrigin,
  scopeAuthRecord,
  urlOrigin,
} from './remote-auth-scope.js';

const acme = { mode: 'remote', remoteUrl: 'https://acme.example.com', apiKey: 'acme-key' };
const other = { mode: 'remote', remoteUrl: 'https://other.example.com', apiKey: '' };
const NOW = Date.parse('2026-10-09T00:00:00Z');

describe('scopeAuthRecord', () => {
  it('stamps the token with the origin of the page that saved it', () => {
    expect(scopeAuthRecord({ token: 't' }, 'https://ACME.example.com')).toEqual({
      token: 't',
      origin: 'https://acme.example.com',
    });
  });

  it('replaces a caller-supplied origin and leaves non-http senders unscoped', () => {
    expect(
      scopeAuthRecord(
        { token: 't', origin: 'https://evil.example.com' },
        'https://acme.example.com',
      ).origin,
    ).toBe('https://acme.example.com');
    expect(scopeAuthRecord({ token: 't', origin: 'https://x' }, 'null')).toEqual({ token: 't' });
    expect(scopeAuthRecord({ token: 't' }, 'file://')).toEqual({ token: 't' });
    expect(scopeAuthRecord({ token: 't' }, null)).toEqual({ token: 't' });
  });
});

describe('authRecordFromIpc', () => {
  it('clears on a null or malformed record', () => {
    const event = { senderFrame: { origin: 'https://acme.example.com' } };
    expect(authRecordFromIpc(event, null)).toBeNull();
    expect(authRecordFromIpc(event, { token: 42 } as any)).toBeNull();
  });

  it('binds a login that finishes after the connection moved to the server that issued it', () => {
    // Sign-in to A is in flight; the user edits the server URL to B, which
    // rewrites the connection before A's response persists the token.
    // The renderer is still A's page; the connection already names B.
    const senderOnA = { senderFrame: { origin: 'https://acme.example.com' } };
    const connection = other;
    const saved = authRecordFromIpc(senderOnA, { token: 'acme-jwt' });

    expect(saved?.origin).toBe('https://acme.example.com');
    // B never receives A's token...
    expect(
      remoteAuthHeaders({
        connection,
        authRecord: saved,
        requestUrl: 'https://other.example.com/',
        now: NOW,
      }),
    ).toEqual({});
    // ...and A still gets it back once the user returns.
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: saved,
        requestUrl: 'https://acme.example.com/',
        now: NOW,
      }),
    ).toEqual({ Authorization: 'Bearer acme-jwt' });
  });

  it('leaves a token from a sender without a frame unscoped', () => {
    expect(authRecordFromIpc({ senderFrame: null }, { token: 't' })).toEqual({ token: 't' });
  });
});

describe('remoteAuthHeaders', () => {
  const acmeToken = scopeAuthRecord({ token: 'acme-jwt' }, 'https://acme.example.com');

  it('sends the JWT back to the origin that issued it', () => {
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: acmeToken,
        requestUrl: 'https://acme.example.com/index.html',
        now: NOW,
      }),
    ).toEqual({ Authorization: 'Bearer acme-jwt' });
  });

  it('never sends an old server JWT after the connection moves to a new origin', () => {
    expect(
      remoteAuthHeaders({
        connection: other,
        authRecord: acmeToken,
        requestUrl: 'https://other.example.com/',
        now: NOW,
      }),
    ).toEqual({});
  });

  it('does not send an unscoped token and falls back to the connection key', () => {
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: { token: 'unscoped' },
        requestUrl: 'https://acme.example.com/',
        now: NOW,
      }),
    ).toEqual({ 'X-API-Key': 'acme-key' });
  });

  it('skips expired tokens, other hosts, and local mode', () => {
    const expired = { ...acmeToken, expiresAt: '2026-01-01T00:00:00Z' };
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: expired,
        requestUrl: 'https://acme.example.com/',
        now: NOW,
      }),
    ).toEqual({ 'X-API-Key': 'acme-key' });
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: acmeToken,
        requestUrl: 'https://cdn.example.net/app.js',
        now: NOW,
      }),
    ).toEqual({});
    expect(
      remoteAuthHeaders({
        connection: { mode: 'local', remoteUrl: 'https://acme.example.com', apiKey: 'k' },
        authRecord: acmeToken,
        requestUrl: 'https://acme.example.com/',
        now: NOW,
      }),
    ).toEqual({});
  });

  it('treats a scheme change as a different server', () => {
    expect(urlOrigin('http://acme.example.com/x')).not.toBe(urlOrigin('https://acme.example.com'));
    expect(
      remoteAuthHeaders({
        connection: acme,
        authRecord: acmeToken,
        requestUrl: 'http://acme.example.com/',
        now: NOW,
      }),
    ).toEqual({});
  });
});

describe('WebSocket handshakes', () => {
  const acmeToken = scopeAuthRecord({ token: 'acme-jwt' }, 'https://acme.example.com');
  const localHttp = { mode: 'remote', remoteUrl: 'http://hub.lan:3051', apiKey: 'lan-key' };
  const headersFor = (connection: typeof acme, requestUrl: string, authRecord = acmeToken) =>
    remoteAuthHeaders({ connection, authRecord, requestUrl, now: NOW });

  it('maps ws/wss to http/https and keeps scheme and port', () => {
    expect(requestOrigin('wss://ACME.example.com:443/api/ws')).toBe('https://acme.example.com');
    expect(requestOrigin('ws://hub.lan:3051/ws')).toBe('http://hub.lan:3051');
    expect(requestOrigin('ftp://acme.example.com')).toBeNull();
  });

  it('sends the JWT on a wss handshake to an https server', () => {
    expect(headersFor(acme, 'wss://acme.example.com/ws?x=1')).toEqual({
      Authorization: 'Bearer acme-jwt',
    });
  });

  it('sends the API key on wss (https server) and ws (http server) handshakes', () => {
    expect(headersFor(acme, 'wss://acme.example.com/ws', null as any)).toEqual({
      'X-API-Key': 'acme-key',
    });
    expect(headersFor(localHttp, 'ws://hub.lan:3051/ws', null as any)).toEqual({
      'X-API-Key': 'lan-key',
    });
  });

  it('sends nothing to a WebSocket on another host, scheme, or port', () => {
    expect(headersFor(acme, 'wss://other.example.com/ws')).toEqual({});
    // ws:// maps to http://, not the configured https:// origin.
    expect(headersFor(acme, 'ws://acme.example.com/ws')).toEqual({});
    expect(headersFor(acme, 'wss://acme.example.com:8443/ws')).toEqual({});
    expect(headersFor(localHttp, 'ws://hub.lan:3052/ws', null as any)).toEqual({});
  });

  it('never accepts a ws/wss origin as a token issuer', () => {
    expect(scopeAuthRecord({ token: 't' }, 'wss://acme.example.com')).toEqual({ token: 't' });
    expect(
      authRecordFromIpc({ senderFrame: { origin: 'ws://hub.lan:3051' } }, { token: 't' }),
    ).toEqual({
      token: 't',
    });
  });
});
