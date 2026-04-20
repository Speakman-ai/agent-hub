/**
 * Preview-auth Express route factory tests (W2).
 *
 * Uses supertest to exercise the router in isolation (no global server,
 * no main authMiddleware). The factory takes an `adminAuth` predicate —
 * tests pass a trivial header-based one so we can flip between "admin"
 * and "anon" requests without hauling in the full JWT stack.
 */

import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { PREVIEW_AUTH_SCHEMA } from './preview-auth-schema.js';
import {
  MAGIC_LINK_QUERY_PARAM,
  PREVIEW_SESSION_COOKIE,
  PREVIEW_STATE_COOKIE,
  encodeStatePayload,
  hashToken,
  issueMagicLink,
  redeemMagicLink,
  signSessionCookie,
  type PreviewAuthConfig,
  type PreviewAuthDeps,
} from './preview-auth.js';
import { createPreviewAuthRoutes } from './preview-auth-routes.js';

function baseConfig(overrides: Partial<PreviewAuthConfig> = {}): PreviewAuthConfig {
  return {
    githubClientId: 'cid',
    githubClientSecret: 'secret',
    githubOrg: 'acme-org',
    baseUrl: 'https://preview.example.com',
    sessionSecret: 'routes-test-secret',
    secureCookies: false, // supertest runs over plain HTTP
    ...overrides,
  };
}

function buildApp(args: {
  fetchImpl?: typeof fetch;
  nowMs?: number;
  adminHeader?: string;
  config?: Partial<PreviewAuthConfig>;
}) {
  const db = new Database(':memory:');
  db.exec(PREVIEW_AUTH_SCHEMA);
  let nowMs = args.nowMs ?? Date.UTC(2026, 0, 1);
  let counter = 0;
  const deps: PreviewAuthDeps = {
    db,
    config: baseConfig(args.config),
    now: () => nowMs,
    randomBytes: (n) => {
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = (counter + i) & 0xff;
      counter += 1;
      return buf;
    },
    fetch: args.fetchImpl,
  };

  const app = express();
  app.use(
    createPreviewAuthRoutes({
      ...deps,
      adminAuth: (req) => {
        const token = req.headers['x-admin-token'];
        if (typeof token === 'string' && token === args.adminHeader) {
          return `admin:${token}`;
        }
        return null;
      },
    }),
  );
  return { app, db, deps, setNow: (ms: number) => (nowMs = ms) };
}

describe('GET /preview/auth/login', () => {
  it('302s to GitHub and sets a state cookie', async () => {
    const { app } = buildApp({});
    const res = await request(app).get('/preview/auth/login?next=/some/page');
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);
    expect(res.headers.location).toContain('state=');
    const setCookie = res.headers['set-cookie'] as unknown as string[] | string;
    const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
    const stateCookie = cookies.find((c) => c.startsWith(`${PREVIEW_STATE_COOKIE}=`));
    expect(stateCookie).toBeDefined();
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('SameSite=Lax');
  });

  it('defaults next to "/" when missing or open-redirect attempt', async () => {
    const { app } = buildApp({});
    const res = await request(app).get('/preview/auth/login?next=https://evil.com');
    // The state cookie payload should round-trip "/" after sanitization.
    expect(res.status).toBe(302);
    const setCookie = res.headers['set-cookie'] as unknown as string[];
    const stateCookie = setCookie.find((c) => c.startsWith(`${PREVIEW_STATE_COOKIE}=`));
    expect(stateCookie).toBeDefined();
    // The payload must NOT contain "evil.com" (we sanitized to "/").
    expect(stateCookie).not.toContain('evil.com');
  });
});

describe('GET /preview/auth/callback', () => {
  it('returns 400 when state/code missing', async () => {
    const { app } = buildApp({});
    await request(app).get('/preview/auth/callback').expect(400);
    await request(app).get('/preview/auth/callback?code=c').expect(400);
    await request(app).get('/preview/auth/callback?state=s').expect(400);
  });

  it('returns 400 when state cookie is missing', async () => {
    const { app } = buildApp({});
    const res = await request(app).get('/preview/auth/callback?code=c&state=s');
    expect(res.status).toBe(400);
    expect(res.text).toContain('cookie');
  });

  it('returns 400 when state does not match the cookie payload', async () => {
    const { app, deps } = buildApp({});
    // Forge a state cookie that says "real-state" but we pass a different
    // state query param.
    const signed = signSessionCookie('real-state|%2F', deps.config.sessionSecret);
    const res = await request(app)
      .get('/preview/auth/callback?code=c&state=different')
      .set('Cookie', `${PREVIEW_STATE_COOKIE}=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain('State mismatch');
  });

  it('403s when user is not an org member', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_xxx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'bob', id: 2 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/')) return new Response(null, { status: 404 });
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const { app, deps } = buildApp({ fetchImpl });
    const signed = signSessionCookie('xyz|%2F', deps.config.sessionSecret);
    const res = await request(app)
      .get('/preview/auth/callback?code=c&state=xyz')
      .set('Cookie', `${PREVIEW_STATE_COOKIE}=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(403);
    expect(res.text).toContain('acme-org');
  });

  it('302s to the next URL and sets a session cookie on success', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_xxx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice', id: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/')) return new Response(null, { status: 204 });
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const { app, deps } = buildApp({
      fetchImpl,
      config: { cookieDomain: '.preview.example.com', secureCookies: true },
    });
    // New 3-field state payload — the middleware stores the PR host so
    // the callback can build an absolute redirect back to it.
    const signed = signSessionCookie(
      encodeStatePayload({
        state: 'xyz',
        host: 'pr-42.preview.example.com',
        nextUrl: '/deep/link',
      }),
      deps.config.sessionSecret,
    );
    const res = await request(app)
      .get('/preview/auth/callback?code=c&state=xyz')
      .set('Cookie', `${PREVIEW_STATE_COOKIE}=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(302);
    // Absolute URL back to the originating PR env — this is the W2
    // cross-host fix. A bare `/deep/link` would leave the browser on
    // the callback host (preview.example.com), never returning to
    // pr-42.preview.example.com.
    expect(res.headers.location).toBe('https://pr-42.preview.example.com/deep/link');
    const setCookies = res.headers['set-cookie'] as unknown as string[];
    // Session cookie AND state-clear cookie both emit Domain= so the
    // session is visible on the PR host the browser is about to hit.
    const sessionCookie = setCookies.find((c) => c.startsWith(`${PREVIEW_SESSION_COOKIE}=`));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain('Domain=.preview.example.com');
    expect(
      setCookies.some((c) => c.startsWith(`${PREVIEW_STATE_COOKIE}=`) && /Max-Age=0/i.test(c)),
    ).toBe(true);
  });

  it('falls back to "/" when the state payload has no host (legacy format)', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_xxx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice', id: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/')) return new Response(null, { status: 204 });
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const { app, deps } = buildApp({ fetchImpl });
    // Two-field legacy payload — host is empty, so redirect lands on "/".
    const signed = signSessionCookie(
      `xyz|${encodeURIComponent('/deep')}`,
      deps.config.sessionSecret,
    );
    const res = await request(app)
      .get('/preview/auth/callback?code=c&state=xyz')
      .set('Cookie', `${PREVIEW_STATE_COOKIE}=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  it('refuses to redirect to a host outside the cookieDomain suffix', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/login/oauth/access_token')) {
        return new Response(JSON.stringify({ access_token: 'gho_xxx' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ login: 'alice', id: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/orgs/')) return new Response(null, { status: 204 });
      return new Response('nope', { status: 500 });
    }) as typeof fetch;
    const { app, deps } = buildApp({
      fetchImpl,
      config: { cookieDomain: '.preview.example.com' },
    });
    // Forged state cookie pointing at an off-domain host.
    const signed = signSessionCookie(
      encodeStatePayload({
        state: 'xyz',
        host: 'pr-1.evil.example.net',
        nextUrl: '/',
      }),
      deps.config.sessionSecret,
    );
    const res = await request(app)
      .get('/preview/auth/callback?code=c&state=xyz')
      .set('Cookie', `${PREVIEW_STATE_COOKIE}=${encodeURIComponent(signed)}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('POST /api/preview/magic-links', () => {
  it('401s without admin auth', async () => {
    const { app } = buildApp({ adminHeader: 'letmein' });
    const res = await request(app).post('/api/preview/magic-links').send({ prNumber: 42 });
    expect(res.status).toBe(401);
  });

  it('400s on missing/invalid prNumber', async () => {
    const { app } = buildApp({ adminHeader: 'letmein' });
    const res = await request(app)
      .post('/api/preview/magic-links')
      .set('X-Admin-Token', 'letmein')
      .send({});
    expect(res.status).toBe(400);
  });

  it('issues a token and returns a pr-scoped URL', async () => {
    const { app, db } = buildApp({ adminHeader: 'letmein' });
    const res = await request(app)
      .post('/api/preview/magic-links')
      .set('X-Admin-Token', 'letmein')
      .send({ prNumber: 42 });
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(res.body.url).toContain('pr-42.');
    expect(res.body.url).toContain(`${MAGIC_LINK_QUERY_PARAM}=`);
    expect(res.body.prNumber).toBe(42);
    expect(res.body.createdBy).toBe('admin:letmein');
    // Default baseUrl is https:// — assert scheme follows through.
    expect(res.body.url.startsWith('https://pr-42.preview.example.com/')).toBe(true);
    // DB has only the hash.
    const row = db.prepare(`SELECT token_hash FROM preview_magic_links`).get() as {
      token_hash: string;
    };
    expect(row.token_hash).toBe(hashToken(res.body.token));
  });

  it('preserves http:// scheme from baseUrl (dev-over-HTTP support)', async () => {
    // Regression: previous code hard-coded `https://` in the URL it
    // returned to the operator, which made dev against `http://localhost:3051`
    // produce an unreachable URL. The response URL's scheme must follow
    // whatever baseUrl declares.
    const { app } = buildApp({
      adminHeader: 'letmein',
      config: { baseUrl: 'http://localhost:3051' },
    });
    const res = await request(app)
      .post('/api/preview/magic-links')
      .set('X-Admin-Token', 'letmein')
      .send({ prNumber: 7 });
    expect(res.status).toBe(201);
    expect(res.body.url.startsWith('http://pr-7.localhost:3051/')).toBe(true);
    expect(res.body.url).not.toContain('https://');
  });
});

describe('POST /api/preview/magic-links/:token/revoke', () => {
  it('401s without admin auth', async () => {
    const { app } = buildApp({ adminHeader: 'letmein' });
    const res = await request(app).post('/api/preview/magic-links/foo/revoke');
    expect(res.status).toBe(401);
  });

  it('revokes a known token and is idempotent', async () => {
    const { app, deps } = buildApp({ adminHeader: 'letmein' });
    const issued = issueMagicLink(deps, { prNumber: 1, createdBy: 'ops' });
    const first = await request(app)
      .post(`/api/preview/magic-links/${encodeURIComponent(issued.token)}/revoke`)
      .set('X-Admin-Token', 'letmein');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ revoked: true });
    const second = await request(app)
      .post(`/api/preview/magic-links/${encodeURIComponent(issued.token)}/revoke`)
      .set('X-Admin-Token', 'letmein');
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ revoked: false });
    // Redemption fails after revoke.
    expect(redeemMagicLink(deps, { token: issued.token, prNumber: 1 }).ok).toBe(false);
  });
});
