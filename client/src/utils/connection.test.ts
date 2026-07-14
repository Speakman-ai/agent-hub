/**
 * Tests for connection.js — focused on `appendAuthToWsUrl`, which is the
 * shim that lets server-issued provisioning wsUrls authenticate without
 * requiring browsers to set headers on `new WebSocket(...)`. Background:
 * see `appendAuthToWsUrl` jsdoc and the WS auth path in
 * `server/auth.ts:authenticateWsDetailed`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock auth.js so we can drive the JWT presence/absence per-test without
// touching real localStorage. Mock connection's own dependencies before
// importing it.
let mockJwt: any = null;
(vi as any).mock('./auth.js', () => ({
  getToken: () => mockJwt,
}));

import { appendAuthToWsUrl, getTerminalWsUrl, saveConnectionConfig } from './connection';

describe('appendAuthToWsUrl', () => {
  beforeEach(() => {
    mockJwt = null;
    // Provide a tiny in-memory localStorage so `saveConnectionConfig` /
    // `getConnectionConfig` work in node.
    const store = new Map();
    (globalThis as any).localStorage = {
      getItem: (k: any) => (store.has(k) ? store.get(k) : null),
      setItem: (k: any, v: any) => store.set(k, String(v)),
      removeItem: (k: any) => store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as any).window = globalThis.window || {};
  });
  afterEach(() => {
    delete (globalThis as any).localStorage;
    mockJwt = null;
  });

  it('appends ?token=<jwt> when a JWT is present', () => {
    mockJwt = 'jwt-abc';
    expect(appendAuthToWsUrl('wss://x/api/y')).toBe('wss://x/api/y?token=jwt-abc');
  });

  it('falls back to ?apiKey when no JWT is present but apiKey is configured', () => {
    saveConnectionConfig({ mode: 'remote', remoteUrl: 'https://x', apiKey: 'k1' });
    expect(appendAuthToWsUrl('wss://x/api/y')).toBe('wss://x/api/y?apiKey=k1');
  });

  it('returns the URL unchanged when neither credential is available', () => {
    // Single-user / fresh dev install — no auth at all.
    expect(appendAuthToWsUrl('wss://x/api/y')).toBe('wss://x/api/y');
  });

  it('uses & as the separator when the URL already has a query string', () => {
    mockJwt = 'jwt-abc';
    expect(appendAuthToWsUrl('wss://x/api/y?since=3')).toBe('wss://x/api/y?since=3&token=jwt-abc');
  });

  it('does not double-append when the URL already carries a credential', () => {
    mockJwt = 'jwt-abc';
    expect(appendAuthToWsUrl('wss://x/api/y?token=existing')).toBe('wss://x/api/y?token=existing');
    expect(appendAuthToWsUrl('wss://x/api/y?apiKey=k')).toBe('wss://x/api/y?apiKey=k');
  });

  it('returns non-string inputs as-is', () => {
    expect(appendAuthToWsUrl(null)).toBe(null);
    expect(appendAuthToWsUrl(undefined)).toBe(undefined);
    expect(appendAuthToWsUrl('')).toBe('');
  });

  it('url-encodes JWTs that contain reserved characters', () => {
    mockJwt = 'a b+c/d=';
    expect(appendAuthToWsUrl('wss://x/api/y')).toBe('wss://x/api/y?token=a%20b%2Bc%2Fd%3D');
  });
});

describe('getTerminalWsUrl', () => {
  beforeEach(() => {
    mockJwt = null;
    const store = new Map();
    (globalThis as any).localStorage = {
      getItem: (k: any) => (store.has(k) ? store.get(k) : null),
      setItem: (k: any, v: any) => store.set(k, String(v)),
      removeItem: (k: any) => store.delete(k),
      clear: () => store.clear(),
    };
    (globalThis as any).window = globalThis.window || {};
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
    mockJwt = null;
  });

  it('builds the dedicated remote terminal route and appends browser auth', () => {
    mockJwt = 'jwt-terminal';
    saveConnectionConfig({ mode: 'remote', remoteUrl: 'https://hub.example.test/' });

    expect(getTerminalWsUrl('session/a')).toBe(
      'wss://hub.example.test/api/sessions/session%2Fa/terminal/ws?token=jwt-terminal',
    );
  });
});
