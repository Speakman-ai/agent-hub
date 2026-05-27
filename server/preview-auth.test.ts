/**
 * Unit tests for the preview-iframe auth helpers (ticket + cookie
 * stores, cookie/header parsing). Pure in-memory — no HTTP server.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  PREVIEW_COOKIE_TTL_MS,
  PREVIEW_TICKET_TTL_MS,
  buildPreviewSetCookie,
  consumePreviewCookie,
  consumePreviewTicket,
  issuePreviewCookieToken,
  isPreviewManifestAssetPath,
  matchPreviewProxyPath,
  mintPreviewTicket,
  parseCookieHeader,
  previewAuthStoreSizesForTest,
  previewCookieName,
  readPreviewCookie,
  resetPreviewAuthStoresForTest,
  type PreviewAuthContext,
} from './preview-auth.js';

function ctxFor(userId = 'u1'): PreviewAuthContext {
  return { userId, username: 'alice', role: 'User', orgId: 'org-1' };
}

describe('preview-auth ticket store', () => {
  beforeEach(() => {
    resetPreviewAuthStoresForTest();
  });

  it('mint → consume returns the bound context exactly once', () => {
    const ticket = mintPreviewTicket('sess-1', ctxFor('user-1'));
    expect(typeof ticket).toBe('string');
    expect(ticket.startsWith('ahpt_')).toBe(true);
    const first = consumePreviewTicket(ticket, 'sess-1');
    expect(first).toEqual(ctxFor('user-1'));
    // Replay must fail — single use.
    expect(consumePreviewTicket(ticket, 'sess-1')).toBeNull();
  });

  it('rejects a ticket reused against a different sessionId', () => {
    const ticket = mintPreviewTicket('sess-A', ctxFor());
    expect(consumePreviewTicket(ticket, 'sess-B')).toBeNull();
    // The mismatched lookup must NOT burn the ticket — the legitimate
    // caller should still be able to consume it on the right session.
    expect(consumePreviewTicket(ticket, 'sess-A')).not.toBeNull();
  });

  it('returns null for an unknown ticket', () => {
    expect(consumePreviewTicket('ahpt_unknown', 'sess-1')).toBeNull();
    expect(consumePreviewTicket('', 'sess-1')).toBeNull();
    expect(consumePreviewTicket(null, 'sess-1')).toBeNull();
    expect(consumePreviewTicket(undefined, 'sess-1')).toBeNull();
  });

  it('expires after TTL elapses', () => {
    vi.useFakeTimers();
    try {
      const ticket = mintPreviewTicket('sess-1', ctxFor());
      vi.advanceTimersByTime(PREVIEW_TICKET_TTL_MS + 1);
      expect(consumePreviewTicket(ticket, 'sess-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('issued cookies look up the same context on subsequent calls', () => {
    const token = issuePreviewCookieToken('sess-1', ctxFor('user-7'));
    expect(token.startsWith('ahpc_')).toBe(true);
    // Multiple reads are allowed — cookies are not single-use.
    expect(consumePreviewCookie(token, 'sess-1')).toEqual(ctxFor('user-7'));
    expect(consumePreviewCookie(token, 'sess-1')).toEqual(ctxFor('user-7'));
  });

  it('cookie store enforces sessionId binding', () => {
    const token = issuePreviewCookieToken('sess-1', ctxFor());
    expect(consumePreviewCookie(token, 'other')).toBeNull();
    // The mismatched call must not invalidate the cookie.
    expect(consumePreviewCookie(token, 'sess-1')).not.toBeNull();
  });

  it('cookie tokens expire after TTL elapses', () => {
    vi.useFakeTimers();
    try {
      const token = issuePreviewCookieToken('sess-1', ctxFor());
      vi.advanceTimersByTime(PREVIEW_COOKIE_TTL_MS + 1);
      expect(consumePreviewCookie(token, 'sess-1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('expired records are swept on store read so the maps do not grow unbounded', () => {
    vi.useFakeTimers();
    try {
      mintPreviewTicket('s1', ctxFor());
      issuePreviewCookieToken('s2', ctxFor());
      expect(previewAuthStoreSizesForTest()).toEqual({ tickets: 1, cookies: 1 });
      vi.advanceTimersByTime(PREVIEW_COOKIE_TTL_MS + 1);
      // A subsequent mint triggers the sweep.
      mintPreviewTicket('s3', ctxFor());
      expect(previewAuthStoreSizesForTest()).toEqual({ tickets: 1, cookies: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('preview-auth path matcher', () => {
  it('returns the sessionId for matching mount paths', () => {
    expect(matchPreviewProxyPath('/api/sessions/abc/preview/proxy/')).toBe('abc');
    expect(matchPreviewProxyPath('/api/sessions/abc/preview/proxy')).toBe('abc');
    expect(matchPreviewProxyPath('/api/sessions/abc/preview/proxy/main.js')).toBe('abc');
    expect(matchPreviewProxyPath('/api/sessions/sess%2D1/preview/proxy/')).toBe('sess-1');
  });

  it('rejects non-matching paths', () => {
    expect(matchPreviewProxyPath('/api/sessions/abc/preview/start')).toBeNull();
    expect(matchPreviewProxyPath('/api/sessions/abc/preview')).toBeNull();
    expect(matchPreviewProxyPath('/api/sessions/abc/preview/proxy-but-not')).toBeNull();
    expect(matchPreviewProxyPath('/api/health')).toBeNull();
    expect(matchPreviewProxyPath('')).toBeNull();
    expect(matchPreviewProxyPath(undefined)).toBeNull();
  });
});

describe('isPreviewManifestAssetPath', () => {
  it('matches webmanifest files under the preview proxy mount', () => {
    expect(isPreviewManifestAssetPath('/api/sessions/abc/preview/proxy/manifest.webmanifest')).toBe(
      true,
    );
    expect(
      isPreviewManifestAssetPath('/api/sessions/abc/preview/proxy/assets/site.webmanifest'),
    ).toBe(true);
  });

  it('rejects non-manifest paths', () => {
    expect(isPreviewManifestAssetPath('/api/sessions/abc/preview/proxy/main.js')).toBe(false);
    expect(isPreviewManifestAssetPath('/api/sessions/abc/preview/proxy/')).toBe(false);
    expect(isPreviewManifestAssetPath('/manifest.webmanifest')).toBe(false);
  });
});

describe('preview-auth cookie helpers', () => {
  it('cookie name namespaces by sessionId and strips unsafe chars', () => {
    expect(previewCookieName('abc-123')).toBe('ah_preview_abc-123');
    // Sanitisation: dots, slashes, spaces are dropped (defensive; uuids
    // would never have these but the helper must obey RFC 6265).
    expect(previewCookieName('ab/c.d 1')).toBe('ah_preview_abcd1');
  });

  it('parseCookieHeader handles common shapes', () => {
    expect(parseCookieHeader('a=1; b=2')).toEqual({ a: '1', b: '2' });
    expect(parseCookieHeader('a=hello%20world')).toEqual({ a: 'hello world' });
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
    expect(parseCookieHeader('badly-formed-no-equals')).toEqual({});
    // Trailing/leading whitespace tolerated:
    expect(parseCookieHeader(' a = 1 ;  b = 2 ')).toEqual({ a: '1', b: '2' });
  });

  it('buildPreviewSetCookie pins path, sets HttpOnly + SameSite, omits Secure on http', () => {
    const v = buildPreviewSetCookie('sess-1', 'ahpc_xyz', { secure: false });
    expect(v).toContain('ah_preview_sess-1=ahpc_xyz');
    expect(v).toContain('Path=/api/sessions/sess-1/preview/proxy/');
    expect(v).toContain('HttpOnly');
    expect(v).toContain('SameSite=Strict');
    expect(v).toContain(`Max-Age=${Math.floor(PREVIEW_COOKIE_TTL_MS / 1000)}`);
    expect(v).not.toContain('Secure');
  });

  it('buildPreviewSetCookie adds Secure when secure:true', () => {
    const v = buildPreviewSetCookie('sess-1', 'ahpc_xyz', { secure: true });
    expect(v).toContain('Secure');
  });

  it('buildPreviewSetCookie scopes Path=/ under subdomain mode', () => {
    // Under subdomain dispatch the iframe lives at a per-session
    // origin (`<sid>.preview.<base>`) and EVERY sub-resource request
    // it makes hits `/<some-path>` on that origin. Path-scoping to
    // `/api/sessions/.../preview/proxy/` would mean the browser
    // refuses to send the cookie on any of those, breaking auth for
    // every JS/CSS/HMR request. Path=/ is safe because the origin
    // itself is per-session (the host label IS the session id).
    const v = buildPreviewSetCookie('sess-1', 'ahpc_xyz', {
      secure: true,
      subdomain: true,
    });
    expect(v).toContain('Path=/');
    expect(v).not.toContain('Path=/api/sessions');
    // SameSite stays Strict — the parent origin and the subdomain
    // origin share an eTLD+1 so iframe loads are same-site.
    expect(v).toContain('SameSite=Strict');
    expect(v).toContain('HttpOnly');
    expect(v).toContain('Secure');
  });

  it('buildPreviewSetCookie default (no subdomain opt) keeps path-prefix scope', () => {
    // Back-compat: callers that haven't been updated for subdomain
    // mode get the old path-scoped cookie. Critical — local Hub /
    // Electron / dev installs MUST keep working unchanged.
    const v = buildPreviewSetCookie('sess-1', 'ahpc_xyz', { secure: true });
    expect(v).toContain('Path=/api/sessions/sess-1/preview/proxy/');
    expect(v).not.toBe('Path=/');
  });

  it('readPreviewCookie pulls the right key by sessionId', () => {
    const req = {
      headers: { cookie: 'ah_preview_sess-1=tok-a; ah_preview_sess-2=tok-b' },
    } as unknown as Parameters<typeof readPreviewCookie>[0];
    expect(readPreviewCookie(req, 'sess-1')).toBe('tok-a');
    expect(readPreviewCookie(req, 'sess-2')).toBe('tok-b');
    expect(readPreviewCookie(req, 'sess-3')).toBeNull();
  });

  it('readPreviewCookie returns null when there is no Cookie header', () => {
    const req = { headers: {} } as unknown as Parameters<typeof readPreviewCookie>[0];
    expect(readPreviewCookie(req, 'sess-1')).toBeNull();
  });
});

afterEach(() => {
  resetPreviewAuthStoresForTest();
});
