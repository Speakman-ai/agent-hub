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

import {
  appendAuthToWsUrl,
  getTerminalWsUrl,
  rebaseWsUrlToClientOrigin,
  saveConnectionConfig,
} from './connection';

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

describe('rebaseWsUrlToClientOrigin', () => {
  let savedWindow: any;
  let hadLocalStorage: boolean;
  let savedLocalStorage: any;
  beforeEach(() => {
    savedWindow = (globalThis as any).window;
    hadLocalStorage = 'localStorage' in (globalThis as any);
    savedLocalStorage = (globalThis as any).localStorage;
    const store = new Map();
    (globalThis as any).localStorage = {
      getItem: (k: any) => (store.has(k) ? store.get(k) : null),
      setItem: (k: any, v: any) => store.set(k, String(v)),
      removeItem: (k: any) => store.delete(k),
      clear: () => store.clear(),
    };
  });
  afterEach(() => {
    (globalThis as any).window = savedWindow;
    // Restore the pre-existing localStorage instead of deleting it wholesale,
    // so a shared test environment doesn't lose its implementation and later
    // suites stay order-independent.
    if (hadLocalStorage) {
      (globalThis as any).localStorage = savedLocalStorage;
    } else {
      delete (globalThis as any).localStorage;
    }
  });

  // The exact Docker / reverse-proxy bug: the app is served from
  // 192.168.50.127:8080 but the server minted ws://192.168.50.127 (port
  // stripped from the Host header). Verbatim, the browser dials :80 and the
  // socket fails before auth, mislabelled as STREAM_DROPPED. The rebase must
  // keep the path but swap in the origin the browser actually used.
  it('rewrites a port-stripped server origin to the same browser origin', () => {
    (globalThis as any).window = {
      location: { protocol: 'http:', hostname: '192.168.50.127', host: '192.168.50.127:8080' },
    };
    expect(rebaseWsUrlToClientOrigin('ws://192.168.50.127/api/provisioning/abc-123/events')).toBe(
      'ws://192.168.50.127:8080/api/provisioning/abc-123/events',
    );
  });

  it('preserves the query string (e.g. ?since=) while rebasing the origin', () => {
    (globalThis as any).window = {
      location: { protocol: 'http:', hostname: '10.0.0.5', host: '10.0.0.5:8080' },
    };
    expect(rebaseWsUrlToClientOrigin('ws://10.0.0.5/api/provisioning/j/events?since=7')).toBe(
      'ws://10.0.0.5:8080/api/provisioning/j/events?since=7',
    );
  });

  it('uses wss when the page is served over https', () => {
    (globalThis as any).window = {
      location: { protocol: 'https:', hostname: 'hub.example.test', host: 'hub.example.test' },
    };
    expect(rebaseWsUrlToClientOrigin('ws://internal-host/api/provisioning/j/events')).toBe(
      'wss://hub.example.test/api/provisioning/j/events',
    );
  });

  it('rebases onto the configured remote base in remote mode', () => {
    (globalThis as any).window = {
      location: { protocol: 'https:', hostname: 'browser', host: 'browser' },
    };
    saveConnectionConfig({ mode: 'remote', remoteUrl: 'https://hub.example.test/' });
    expect(rebaseWsUrlToClientOrigin('ws://internal-host/api/provisioning/j/events')).toBe(
      'wss://hub.example.test/api/provisioning/j/events',
    );
  });

  it('returns non-string / unparseable input unchanged', () => {
    (globalThis as any).window = {
      location: { protocol: 'http:', hostname: 'h', host: 'h:8080' },
    };
    expect(rebaseWsUrlToClientOrigin(null)).toBe(null);
    expect(rebaseWsUrlToClientOrigin(undefined)).toBe(undefined);
    expect(rebaseWsUrlToClientOrigin('')).toBe('');
    expect(rebaseWsUrlToClientOrigin('not a url')).toBe('not a url');
  });

  it('returns the URL unchanged when there is no browser window', () => {
    (globalThis as any).window = undefined;
    expect(rebaseWsUrlToClientOrigin('ws://internal-host/api/provisioning/j/events')).toBe(
      'ws://internal-host/api/provisioning/j/events',
    );
  });
});
