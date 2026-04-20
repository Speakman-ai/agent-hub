/**
 * Preview-URL auth tests (W2).
 *
 * Covers the three required scenarios from the W2 card plus a handful of
 * unit tests around the pure helpers (cookie signing, token hashing,
 * host parsing, session TTL math). All tests use an in-memory SQLite DB
 * and mocked fetch — no real network or filesystem.
 *
 * Required scenarios (from the handoff note):
 *   - unauthorized → redirect to GitHub authorize (Location + state cookie)
 *   - magic-link TTL expiry → frozen clock past TTL → 401
 *   - org-check → 204 allow, 404 deny (403)
 */

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  buildAuthorizeUrl,
  buildPostAuthRedirect,
  checkOrgMembership,
  completeMagicLinkFlow,
  completeOAuthFlow,
  createPreviewAuthMiddleware,
  exchangeCodeForToken,
  extractPrNumberFromHost,
  generateOpaqueToken,
  hashToken,
  issueMagicLink,
  MAGIC_LINK_QUERY_PARAM,
  parseCookies,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_STATE_COOKIE,
  reapExpired,
  redeemMagicLink,
  revokeMagicLink,
  serializeCookie,
  signSessionCookie,
  verifyPreviewSession,
  verifySessionCookie,
  type PreviewAuthConfig,
  type PreviewAuthDeps,
} from './preview-auth.js';
import { PREVIEW_AUTH_SCHEMA } from './preview-auth-schema.js';

// ─── Test scaffolding ─────────────────────────────────────────────────────

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(PREVIEW_AUTH_SCHEMA);
  return db;
}

function baseConfig(overrides: Partial<PreviewAuthConfig> = {}): PreviewAuthConfig {
  return {
    githubClientId: 'test-client-id',
    githubClientSecret: 'test-client-secret',
    githubOrg: 'acme-org',
    baseUrl: 'https://preview.example.com',
    sessionSecret: 'test-session-secret-do-not-use-in-prod',
    oauthSessionTtlSeconds: 3600,
    magicLinkTtlSeconds: 60 * 60 * 24 * 7,
    secureCookies: true,
    ...overrides,
  };
}

/**
 * Build a PreviewAuthDeps wired to an in-memory DB, a frozen clock, a
 * deterministic RNG, and a recorded-fetch mock.
 */
function makeDeps(
  overrides: {
    config?: Partial<PreviewAuthConfig>;
    nowMs?: number;
    fetchImpl?: typeof fetch;
  } = {},
): {
  deps: PreviewAuthDeps;
  db: Database.Database;
  setNow: (ms: number) => void;
  getFetchCalls: () => Array<{ url: string; init?: RequestInit }>;
} {
  const db = freshDb();
  let nowMs = overrides.nowMs ?? Date.UTC(2026, 0, 1, 12, 0, 0);
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch =
    overrides.fetchImpl ??
    (async (input, init) => {
      fetchCalls.push({ url: String(input), init });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  // Deterministic RNG — each call returns an incrementing counter buffer
  // of the requested size. Keeps tokens stable across test runs.
  let counter = 0;
  const randomBytes = (n: number): Buffer => {
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = (counter + i) & 0xff;
    counter += 1;
    return buf;
  };
  const deps: PreviewAuthDeps = {
    db,
    config: baseConfig(overrides.config ?? {}),
    now: () => nowMs,
    randomBytes,
    fetch: fetchImpl,
  };
  return {
    deps,
    db,
    setNow: (ms) => {
      nowMs = ms;
    },
    getFetchCalls: () => fetchCalls,
  };
}

/** Fake Express req/res just rich enough for the middleware. */
function makeReqRes(opts: { host: string; url?: string; cookie?: string }): {
  req: Request;
  res: MockResponse;
} {
  const req = {
    url: opts.url ?? '/',
    headers: {
      host: opts.host,
      cookie: opts.cookie,
    },
  } as unknown as Request;
  const res = new MockResponse();
  return { req, res };
}

class MockResponse {
  statusCode = 200;
  headers: Record<string, string | string[]> = {};
  body = '';
  ended = false;
  setHeader(name: string, value: string | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  getHeader(name: string): string | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
    this.ended = true;
  }
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
  getSetCookies(): string[] {
    const v = this.headers['set-cookie'];
    if (!v) return [];
    return Array.isArray(v) ? v : [v];
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('hashToken / generateOpaqueToken', () => {
  it('hashToken is deterministic and matches sha256 hex', () => {
    const h1 = hashToken('hello');
    const h2 = hashToken('hello');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generateOpaqueToken returns a 43-char base64url string for 32 random bytes', () => {
    const token = generateOpaqueToken(() => Buffer.alloc(32, 7));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a session id', () => {
    const cookie = signSessionCookie('abc123', 'secret');
    expect(verifySessionCookie(cookie, 'secret')).toBe('abc123');
  });

  it('returns null on signature mismatch', () => {
    const cookie = signSessionCookie('abc123', 'secret');
    expect(verifySessionCookie(cookie, 'wrong-secret')).toBeNull();
  });

  it('returns null on malformed cookie', () => {
    expect(verifySessionCookie('no-dot', 'secret')).toBeNull();
    expect(verifySessionCookie('', 'secret')).toBeNull();
    expect(verifySessionCookie('.trailing-dot', 'secret')).toBeNull();
    expect(verifySessionCookie('leading-dot.', 'secret')).toBeNull();
  });

  it('is resistant to tampering with the session id', () => {
    const cookie = signSessionCookie('abc123', 'secret');
    const tampered = cookie.replace('abc123', 'abc124');
    expect(verifySessionCookie(tampered, 'secret')).toBeNull();
  });
});

describe('extractPrNumberFromHost', () => {
  it('extracts the PR number from a standard preview host', () => {
    expect(extractPrNumberFromHost('pr-42.preview.example.com')).toBe(42);
  });

  it('ignores port suffix', () => {
    expect(extractPrNumberFromHost('pr-7.preview.example.com:8443')).toBe(7);
  });

  it('returns null for non-preview hosts', () => {
    expect(extractPrNumberFromHost('example.com')).toBeNull();
    expect(extractPrNumberFromHost('preview.example.com')).toBeNull();
    expect(extractPrNumberFromHost(undefined)).toBeNull();
    expect(extractPrNumberFromHost('pr-.example.com')).toBeNull();
    expect(extractPrNumberFromHost('pr-abc.example.com')).toBeNull();
  });

  it('is case-sensitive — upper-case PR prefix does not match (DNS is canonically lowercase)', () => {
    // Regression: the prior regex carried `/i`, which allowed forged/unusual
    // casings like `PR-42.…` to slip through. Real requests arriving through
    // nginx/Node are already lowercased, so case-insensitive matching only
    // created ambiguity.
    expect(extractPrNumberFromHost('PR-42.preview.example.com')).toBeNull();
    expect(extractPrNumberFromHost('Pr-42.preview.example.com')).toBeNull();
  });
});

describe('parseCookies', () => {
  it('parses a normal Cookie header', () => {
    expect(parseCookies('a=1; b=2')).toEqual({ a: '1', b: '2' });
  });

  it('url-decodes values', () => {
    expect(parseCookies('a=hello%20world')).toEqual({ a: 'hello world' });
  });

  it('returns {} for undefined / empty', () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('')).toEqual({});
  });
});

describe('serializeCookie', () => {
  it('emits HttpOnly+Secure+SameSite=Lax by default', () => {
    const s = serializeCookie('x', 'y', { maxAgeSeconds: 600 });
    expect(s).toContain('x=y');
    expect(s).toContain('Max-Age=600');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('Secure');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('Path=/');
  });

  it('respects secure=false for local dev', () => {
    const s = serializeCookie('x', 'y', { secure: false });
    expect(s).not.toContain('Secure');
  });
});

// ─── Magic-link store ─────────────────────────────────────────────────────

describe('issueMagicLink / redeemMagicLink', () => {
  it('round-trips a freshly issued link', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 42, createdBy: 'alice' });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    const result = redeemMagicLink(deps, { token: issued.token, prNumber: 42 });
    expect(result.ok).toBe(true);
  });

  it('stores only the hash, never the plaintext', () => {
    const { deps, db } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 1, createdBy: 'alice' });
    const rows = db.prepare(`SELECT token_hash FROM preview_magic_links`).all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(issued.token));
    expect(rows[0].token_hash).not.toBe(issued.token);
  });

  it('rejects unknown tokens', () => {
    const { deps } = makeDeps();
    issueMagicLink(deps, { prNumber: 1, createdBy: 'alice' });
    const result = redeemMagicLink(deps, { token: 'nope', prNumber: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok || (result as { reason: string }).reason).toBe('invalid');
  });

  it('rejects tokens for the wrong PR', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 1, createdBy: 'alice' });
    const result = redeemMagicLink(deps, { token: issued.token, prNumber: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('wrong_pr');
  });

  it('rejects revoked tokens', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 1, createdBy: 'alice' });
    expect(revokeMagicLink(deps, issued.token)).toBe(true);
    const result = redeemMagicLink(deps, { token: issued.token, prNumber: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
    // Revoking an already-revoked token is a no-op.
    expect(revokeMagicLink(deps, issued.token)).toBe(false);
  });

  it('rejects expired tokens (frozen clock + TTL advance)', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { deps, setNow } = makeDeps({ nowMs: t0 });
    const issued = issueMagicLink(deps, {
      prNumber: 1,
      createdBy: 'alice',
      ttlSeconds: 60,
    });
    // Just under TTL — still good.
    setNow(t0 + 59_000);
    expect(redeemMagicLink(deps, { token: issued.token, prNumber: 1 }).ok).toBe(true);
    // Advance past TTL.
    setNow(t0 + 61_000);
    const result = redeemMagicLink(deps, { token: issued.token, prNumber: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('validates input', () => {
    const { deps } = makeDeps();
    expect(() => issueMagicLink(deps, { prNumber: 0, createdBy: 'a' })).toThrow();
    expect(() => issueMagicLink(deps, { prNumber: 1, createdBy: '' })).toThrow();
    expect(() => issueMagicLink(deps, { prNumber: 1, createdBy: 'a', ttlSeconds: -1 })).toThrow();
  });
});

describe('completeMagicLinkFlow', () => {
  it('returns a scoped session cookie on success', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 42, createdBy: 'alice' });
    const flow = completeMagicLinkFlow(deps, {
      prNumber: 42,
      token: issued.token,
    });
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      expect(flow.session.kind).toBe('magic_link');
      expect(flow.session.prNumber).toBe(42);
      expect(flow.session.cookieValue).toContain('.');
    }
  });

  it('propagates the TTL ceiling from the magic link', () => {
    // Issue a magic link with a very short TTL, then make sure the
    // resulting session cookie's Max-Age never exceeds it.
    const t0 = Date.UTC(2026, 0, 1);
    const { deps } = makeDeps({ nowMs: t0 });
    const issued = issueMagicLink(deps, {
      prNumber: 7,
      createdBy: 'alice',
      ttlSeconds: 10,
    });
    const flow = completeMagicLinkFlow(deps, {
      prNumber: 7,
      token: issued.token,
    });
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      expect(flow.session.maxAgeSeconds).toBeLessThanOrEqual(10);
      expect(flow.session.maxAgeSeconds).toBeGreaterThan(0);
    }
  });

  it('forwards reject reasons', () => {
    const { deps } = makeDeps();
    const flow = completeMagicLinkFlow(deps, { prNumber: 1, token: 'nope' });
    expect(flow.ok).toBe(false);
    if (!flow.ok) expect(flow.reason).toBe('invalid');
  });
});

describe('verifyPreviewSession', () => {
  it('returns the session row for a valid cookie', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 99, createdBy: 'alice' });
    const flow = completeMagicLinkFlow(deps, { prNumber: 99, token: issued.token });
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      const row = verifyPreviewSession(deps, flow.session.cookieValue);
      expect(row).not.toBeNull();
      expect(row?.kind).toBe('magic_link');
      expect(row?.pr_number).toBe(99);
    }
  });

  it('returns null for a cookie signed with a different secret', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 99, createdBy: 'alice' });
    const flow = completeMagicLinkFlow(deps, { prNumber: 99, token: issued.token });
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      const forged = signSessionCookie(flow.session.sessionId, 'different-secret');
      expect(verifyPreviewSession(deps, forged)).toBeNull();
    }
  });

  it('returns null for an expired session', () => {
    const t0 = Date.UTC(2026, 0, 1);
    const { deps, setNow } = makeDeps({
      nowMs: t0,
      config: { oauthSessionTtlSeconds: 10 },
    });
    // Hand-insert a session with a 10s TTL, then advance past it.
    const issued = issueMagicLink(deps, {
      prNumber: 1,
      createdBy: 'alice',
      ttlSeconds: 5, // session derives from this
    });
    const flow = completeMagicLinkFlow(deps, { prNumber: 1, token: issued.token });
    expect(flow.ok).toBe(true);
    if (flow.ok) {
      setNow(t0 + 60_000); // minute later
      expect(verifyPreviewSession(deps, flow.session.cookieValue)).toBeNull();
    }
  });
});

// ─── OAuth helpers ────────────────────────────────────────────────────────

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, scope, and state', () => {
    const { deps } = makeDeps();
    const url = buildAuthorizeUrl(deps, { state: 'csrf-nonce' });
    expect(url).toContain('https://github.com/login/oauth/authorize?');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain(
      `redirect_uri=${encodeURIComponent('https://preview.example.com/preview/auth/callback')}`,
    );
    expect(url).toContain('state=csrf-nonce');
    expect(url).toContain('scope=read%3Aorg+user%3Aemail');
  });
});

describe('exchangeCodeForToken', () => {
  it('POSTs to /login/oauth/access_token with client creds + code', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(
        JSON.stringify({ access_token: 'gho_xxx', token_type: 'bearer', scope: 'read:org' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    const token = await exchangeCodeForToken(deps, { code: 'abc' });
    expect(token.access_token).toBe('gho_xxx');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://github.com/login/oauth/access_token');
    expect(calls[0].body).toContain('test-client-id');
    expect(calls[0].body).toContain('test-client-secret');
    expect(calls[0].body).toContain('"code":"abc"');
  });

  it('throws when access_token is missing from the response', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: 'bad_verification_code' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    await expect(exchangeCodeForToken(deps, { code: 'bad' })).rejects.toThrow(/bad_verification/);
  });

  it('throws on non-2xx response', async () => {
    const fetchImpl = (async () => new Response('server error', { status: 500 })) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    await expect(exchangeCodeForToken(deps, { code: 'x' })).rejects.toThrow(/500/);
  });
});

describe('checkOrgMembership', () => {
  it('returns true on 204', async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    const ok = await checkOrgMembership(deps, {
      accessToken: 'gho_xxx',
      username: 'alice',
    });
    expect(ok).toBe(true);
  });

  it('returns false on 404', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    const ok = await checkOrgMembership(deps, {
      accessToken: 'gho_xxx',
      username: 'bob',
    });
    expect(ok).toBe(false);
  });

  it('returns false on 302 (non-member redirect)', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { Location: '/bob' } })) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    const ok = await checkOrgMembership(deps, {
      accessToken: 'gho_xxx',
      username: 'bob',
    });
    expect(ok).toBe(false);
  });

  it('URL-encodes the org and username into the path', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const { deps } = makeDeps({
      fetchImpl,
      config: { githubOrg: 'weird org' },
    });
    await checkOrgMembership(deps, {
      accessToken: 'gho',
      username: 'user+name',
    });
    expect(calls[0]).toContain('/orgs/weird%20org/members/user%2Bname');
  });

  it('passes redirect: manual so 302s stay 302 (no false positives)', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const { deps } = makeDeps({ fetchImpl });
    await checkOrgMembership(deps, { accessToken: 'gho', username: 'u' });
    expect(capturedInit?.redirect).toBe('manual');
  });
});

describe('completeOAuthFlow', () => {
  function oauthFetch(opts: {
    tokenStatus?: number;
    tokenBody?: Record<string, unknown>;
    userStatus?: number;
    userBody?: Record<string, unknown>;
    orgStatus: number;
  }): typeof fetch {
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify(opts.tokenBody ?? { access_token: 'gho_xx' }), {
          status: opts.tokenStatus ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify(opts.userBody ?? { login: 'alice', id: 1 }), {
          status: opts.userStatus ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/')) {
        return new Response(null, { status: opts.orgStatus });
      }
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
  }

  it('ok=true + session when user is an org member (204)', async () => {
    const { deps, db } = makeDeps({
      fetchImpl: oauthFetch({ orgStatus: 204 }),
    });
    const result = await completeOAuthFlow(deps, { code: 'abc' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.kind).toBe('oauth');
      expect(result.session.githubLogin).toBe('alice');
      // DB row was created.
      const rows = db.prepare(`SELECT * FROM preview_auth_sessions`).all();
      expect(rows).toHaveLength(1);
    }
  });

  it('ok=false + reason=not_member when org check 404s', async () => {
    const { deps } = makeDeps({
      fetchImpl: oauthFetch({ orgStatus: 404 }),
    });
    const result = await completeOAuthFlow(deps, { code: 'abc' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_member');
  });

  it('ok=false + reason=token_exchange_failed on bad code', async () => {
    const { deps } = makeDeps({
      fetchImpl: oauthFetch({
        tokenStatus: 200,
        tokenBody: { error: 'bad_verification_code' },
        orgStatus: 204,
      }),
    });
    const result = await completeOAuthFlow(deps, { code: 'bad' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('token_exchange_failed');
  });
});

// ─── Middleware: unauthenticated → redirect ──────────────────────────────

describe('createPreviewAuthMiddleware — unauthenticated', () => {
  it('redirects to GitHub authorize AND sets a signed state cookie', () => {
    const { deps } = makeDeps();
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-42.preview.example.com',
      url: '/some/path?foo=bar',
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(302);
    const location = res.getHeader('location') as string;
    expect(location).toContain('https://github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
    expect(location).toMatch(/state=[A-Za-z0-9_-]+/);

    const cookies = res.getSetCookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain(`${PREVIEW_STATE_COOKIE}=`);
    expect(cookies[0]).toContain('HttpOnly');
    expect(cookies[0]).toContain('Secure');
    expect(cookies[0]).toContain('SameSite=Lax');

    // The state cookie value, once url-decoded and verified, should
    // contain the same `state` that ended up in the Location header —
    // that's the CSRF linkage.
    const rawCookie = /preview_auth_state=([^;]+)/.exec(cookies[0])?.[1] ?? '';
    const decoded = decodeURIComponent(rawCookie);
    const payload = verifySessionCookie(decoded, deps.config.sessionSecret);
    expect(payload).not.toBeNull();
    const stateFromLocation = /state=([A-Za-z0-9_-]+)/.exec(location)?.[1] ?? '';
    expect(payload?.startsWith(stateFromLocation + '|')).toBe(true);
    // `next` URL round-tripped (url-encoded) into the cookie payload.
    expect(payload).toContain(encodeURIComponent('/some/path?foo=bar'));
  });

  it('passes through for non-preview hosts', () => {
    const { deps } = makeDeps();
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'app.example.com',
      url: '/api/whatever',
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.ended).toBe(false);
  });

  it('emits Domain= on the state cookie when cookieDomain is configured', () => {
    // Regression for the cross-host scoping fix: without Domain= the state
    // cookie set on `pr-N.preview.example.com` would never follow the OAuth
    // redirect back to the callback host (e.g. `preview.example.com` or the
    // auth subdomain), breaking the CSRF check. The middleware must thread
    // `config.cookieDomain` through to `serializeCookie`.
    const { deps } = makeDeps({
      config: { cookieDomain: '.preview.example.com' },
    });
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-42.preview.example.com',
      url: '/deep/link',
    });
    middleware(req, res as unknown as Response, vi.fn());

    const cookies = res.getSetCookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('Domain=.preview.example.com');
  });

  it('allows requests carrying a valid session cookie', () => {
    const { deps } = makeDeps();
    // Issue + redeem a magic link to produce a real signed cookie.
    const issued = issueMagicLink(deps, { prNumber: 5, createdBy: 'alice' });
    const flow = completeMagicLinkFlow(deps, { prNumber: 5, token: issued.token });
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    const cookieHeader = `${PREVIEW_SESSION_COOKIE}=${encodeURIComponent(flow.session.cookieValue)}`;

    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-5.preview.example.com',
      url: '/',
      cookie: cookieHeader,
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res.ended).toBe(false);
  });

  it('rejects scoped session cookie on the wrong PR (403)', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 5, createdBy: 'alice' });
    const flow = completeMagicLinkFlow(deps, { prNumber: 5, token: issued.token });
    expect(flow.ok).toBe(true);
    if (!flow.ok) return;
    const cookieHeader = `${PREVIEW_SESSION_COOKIE}=${encodeURIComponent(flow.session.cookieValue)}`;
    const middleware = createPreviewAuthMiddleware(deps);
    // Same cookie, different preview host.
    const { req, res } = makeReqRes({
      host: 'pr-6.preview.example.com',
      url: '/',
      cookie: cookieHeader,
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });
});

// ─── Middleware: magic-link happy path + TTL expiry ───────────────────────

describe('createPreviewAuthMiddleware — magic link', () => {
  it('302s to the cleaned URL and sets a session cookie on redemption', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 3, createdBy: 'alice' });
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-3.preview.example.com',
      url: `/some/page?foo=bar&${MAGIC_LINK_QUERY_PARAM}=${encodeURIComponent(issued.token)}`,
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(302);
    const location = res.getHeader('location') as string;
    // Magic-link token stripped from the redirect target.
    expect(location).toBe('/some/page?foo=bar');
    expect(next).not.toHaveBeenCalled();
    const cookies = res.getSetCookies();
    expect(cookies[0]).toContain(`${PREVIEW_SESSION_COOKIE}=`);
  });

  it('returns 401 when a magic-link token has expired (frozen clock past TTL)', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { deps, setNow } = makeDeps({ nowMs: t0 });
    const issued = issueMagicLink(deps, {
      prNumber: 9,
      createdBy: 'alice',
      ttlSeconds: 60,
    });
    // Advance past TTL.
    setNow(t0 + 120_000);
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-9.preview.example.com',
      url: `/?${MAGIC_LINK_QUERY_PARAM}=${encodeURIComponent(issued.token)}`,
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(res.body).toContain('expired');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when a magic-link token is for the wrong PR', () => {
    const { deps } = makeDeps();
    const issued = issueMagicLink(deps, { prNumber: 3, createdBy: 'alice' });
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-4.preview.example.com',
      url: `/?${MAGIC_LINK_QUERY_PARAM}=${encodeURIComponent(issued.token)}`,
    });
    const next = vi.fn();
    middleware(req, res as unknown as Response, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when a magic-link token is unknown', () => {
    const { deps } = makeDeps();
    const middleware = createPreviewAuthMiddleware(deps);
    const { req, res } = makeReqRes({
      host: 'pr-1.preview.example.com',
      url: `/?${MAGIC_LINK_QUERY_PARAM}=nope`,
    });
    middleware(req, res as unknown as Response, vi.fn());
    expect(res.statusCode).toBe(401);
  });
});

// ─── reapExpired ──────────────────────────────────────────────────────────

describe('reapExpired', () => {
  it('deletes expired rows only', () => {
    const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
    const { deps, db, setNow } = makeDeps({ nowMs: t0 });
    issueMagicLink(deps, { prNumber: 1, createdBy: 'a', ttlSeconds: 30 });
    issueMagicLink(deps, { prNumber: 2, createdBy: 'a', ttlSeconds: 3600 });
    setNow(t0 + 60_000); // 60s in — first one expired, second alive
    const res = reapExpired(deps);
    expect(res.magicLinks).toBe(1);
    const remaining = db.prepare(`SELECT pr_number FROM preview_magic_links`).all() as Array<{
      pr_number: number;
    }>;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].pr_number).toBe(2);
  });

  it('returns {magicLinks:0, sessions:0} when nothing is expired', () => {
    const { deps } = makeDeps();
    issueMagicLink(deps, { prNumber: 1, createdBy: 'a' });
    const res = reapExpired(deps);
    expect(res.magicLinks).toBe(0);
    expect(res.sessions).toBe(0);
  });
});

// ─── buildPostAuthRedirect ───────────────────────────────────────────────

describe('buildPostAuthRedirect', () => {
  it('builds absolute URL for valid PR host within cookieDomain', () => {
    const url = buildPostAuthRedirect({
      host: 'pr-5.preview.example.com',
      nextUrl: '/dashboard',
      cookieDomain: '.preview.example.com',
      secure: true,
    });
    expect(url).toBe('https://pr-5.preview.example.com/dashboard');
  });

  it('falls back to / for non-PR host', () => {
    expect(
      buildPostAuthRedirect({
        host: 'evil.example.com',
        nextUrl: '/x',
        cookieDomain: null,
        secure: true,
      }),
    ).toBe('/');
  });

  it('rejects host outside cookieDomain (completely different domain)', () => {
    expect(
      buildPostAuthRedirect({
        host: 'pr-1.evil.example.net',
        nextUrl: '/',
        cookieDomain: '.preview.example.com',
        secure: true,
      }),
    ).toBe('/');
  });

  it('rejects host that shares suffix but not a dot boundary (endsWith boundary bug)', () => {
    // e.g. "xpreview.example.com" ends with "preview.example.com" but is
    // not a proper subdomain — the dot boundary must be enforced.
    expect(
      buildPostAuthRedirect({
        host: 'pr-1.xpreview.example.com',
        nextUrl: '/',
        cookieDomain: '.preview.example.com',
        secure: true,
      }),
    ).toBe('/');

    expect(
      buildPostAuthRedirect({
        host: 'pr-1.notpreview.example.com',
        nextUrl: '/',
        cookieDomain: '.preview.example.com',
        secure: true,
      }),
    ).toBe('/');
  });

  it('accepts host that exactly matches bare cookieDomain', () => {
    // Edge case: host IS the cookie domain (no subdomain prefix beyond pr-N).
    // This would only match if the PR host happened to be the bare domain,
    // but extractPrNumberFromHost would reject it. Tested for completeness.
    expect(
      buildPostAuthRedirect({
        host: 'preview.example.com',
        nextUrl: '/',
        cookieDomain: '.preview.example.com',
        secure: true,
      }),
    ).toBe('/'); // no pr-N prefix → rejected by extractPrNumberFromHost
  });

  it('uses http scheme when secure is false', () => {
    const url = buildPostAuthRedirect({
      host: 'pr-3.preview.example.com',
      nextUrl: '/page',
      cookieDomain: '.preview.example.com',
      secure: false,
    });
    expect(url).toBe('http://pr-3.preview.example.com/page');
  });

  it('defaults nextUrl to / when empty or missing leading slash', () => {
    const url = buildPostAuthRedirect({
      host: 'pr-1.preview.example.com',
      nextUrl: '',
      cookieDomain: '.preview.example.com',
      secure: true,
    });
    expect(url).toBe('https://pr-1.preview.example.com/');
  });

  it('works without cookieDomain (null) for valid PR host', () => {
    const url = buildPostAuthRedirect({
      host: 'pr-7.anything.local',
      nextUrl: '/test',
      cookieDomain: null,
      secure: false,
    });
    expect(url).toBe('http://pr-7.anything.local/test');
  });
});
