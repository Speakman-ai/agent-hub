import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import express from 'express';
import request from 'supertest';
import { WebSocket, WebSocketServer } from 'ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESS_COOKIE,
  PASSWORD_COOKIE,
  UNLOCK_PATH,
  buildAccessSetCookie,
  consumeMemberTicket,
  createPrEnvironmentAccessGate,
  createPrEnvironmentShareStore,
  decideAccess,
  mintMemberSession,
  mintMemberTicket,
  mintPasswordUnlock,
  resetMemberTicketsForTest,
  shareTokenFor,
  stripAccessCookies,
  verifyMemberSession,
  verifyShareToken,
  PR_ENVIRONMENT_SHARE_SCHEMA,
  MEMBER_SESSION_TTL_MS,
  type PrEnvironmentShareStore,
} from './pr-environment-share.js';
import {
  attachPrEnvironmentUpgrade,
  createPrEnvironmentProxyMiddleware,
  sendStatusPage,
  type PrEnvironmentIngressRecord,
} from './pr-environment-proxy.js';
import { hashPassword, verifyPassword } from '../password.js';

const ENV = { projectId: 'demo', prNumber: 7 };
const HOUR = 60 * 60_000;

function freshStore(): PrEnvironmentShareStore {
  const db = new Database(':memory:');
  db.exec(PR_ENVIRONMENT_SHARE_SCHEMA);
  return createPrEnvironmentShareStore(db);
}

function mkLink(
  store: PrEnvironmentShareStore,
  now: number,
  opts: Partial<{ pr: number; hours: number }> = {},
) {
  return store.create({
    projectId: 'demo',
    prNumber: opts.pr ?? 7,
    label: null,
    createdBy: 'u1',
    expiresAt: now + (opts.hours ?? 24) * HOUR,
    now,
  });
}

describe('share tokens', () => {
  it('verifies a minted token for its own environment', () => {
    const store = freshStore();
    const link = mkLink(store, 1000);
    const token = shareTokenFor(store.secret(), link);
    expect(verifyShareToken(store, token, ENV, 2000)).toEqual({ ok: true, link });
  });

  it('rejects a token on another environment', () => {
    const store = freshStore();
    const token = shareTokenFor(store.secret(), mkLink(store, 1000));
    expect(verifyShareToken(store, token, { projectId: 'demo', prNumber: 8 }, 2000)).toEqual({
      ok: false,
      reason: 'wrong_environment',
    });
    expect(verifyShareToken(store, token, { projectId: 'other', prNumber: 7 }, 2000).ok).toBe(
      false,
    );
  });

  it('rejects a forged or tampered signature', () => {
    const store = freshStore();
    const link = mkLink(store, 1000);
    const token = shareTokenFor(store.secret(), link);
    expect(verifyShareToken(store, `${token.slice(0, -2)}xx`, ENV, 2000).ok).toBe(false);
    expect(verifyShareToken(store, `ahs_${link.id}.`, ENV, 2000).ok).toBe(false);
    // A token signed with another org's key does not verify here.
    const other = freshStore();
    expect(verifyShareToken(store, shareTokenFor(other.secret(), link), ENV, 2000).ok).toBe(false);
    expect(verifyShareToken(store, 'garbage', ENV, 2000).ok).toBe(false);
  });

  it('expires at expires_at', () => {
    const store = freshStore();
    const link = mkLink(store, 1000, { hours: 1 });
    const token = shareTokenFor(store.secret(), link);
    expect(verifyShareToken(store, token, ENV, 1000 + HOUR - 1).ok).toBe(true);
    expect(verifyShareToken(store, token, ENV, 1000 + HOUR)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('stops verifying once revoked, and revoking twice keeps the first stamp', () => {
    const store = freshStore();
    const link = mkLink(store, 1000);
    const token = shareTokenFor(store.secret(), link);
    expect(store.revoke(link.id, 'admin', 1500)?.revoked_at).toBe(1500);
    expect(store.revoke(link.id, 'admin', 1600)?.revoked_at).toBe(1500);
    expect(verifyShareToken(store, token, ENV, 2000)).toEqual({ ok: false, reason: 'revoked' });
    expect(store.revoke('missing', 'admin', 1600)).toBeNull();
  });
});

describe('member tickets and sessions', () => {
  beforeEach(() => resetMemberTicketsForTest());

  it('a ticket is single-use and bound to its environment', () => {
    const org = freshStore();
    const t = mintMemberTicket(org, ENV, 'u1', 1000);
    expect(consumeMemberTicket(org, t, { projectId: 'demo', prNumber: 8 }, 1001)).toBeNull();
    // A wrong-environment attempt burns it too.
    expect(consumeMemberTicket(org, t, ENV, 1002)).toBeNull();
    const t2 = mintMemberTicket(org, ENV, 'u1', 1000);
    expect(consumeMemberTicket(org, t2, ENV, 1001)).toEqual({ userId: 'u1' });
    expect(consumeMemberTicket(org, t2, ENV, 1002)).toBeNull();
  });

  it('a ticket expires after 60 s', () => {
    const org = freshStore();
    const t = mintMemberTicket(org, ENV, 'u1', 1000);
    expect(consumeMemberTicket(org, t, ENV, 61_000)).toBeNull();
  });

  it("a ticket from one org does not open another org's environment with the same ids", () => {
    const orgA = freshStore();
    const orgB = freshStore();
    const t = mintMemberTicket(orgA, ENV, 'u1', 1000);
    expect(consumeMemberTicket(orgB, t, ENV, 1001)).toBeNull();
    // And the attempt burned it.
    expect(consumeMemberTicket(orgA, t, ENV, 1002)).toBeNull();
  });

  it('a member session is environment-bound and expires', () => {
    const store = freshStore();
    const s = mintMemberSession(store.secret(), ENV, 'u1', 1000);
    expect(verifyMemberSession(store.secret(), s, ENV, 2000)).toBe(true);
    expect(verifyMemberSession(store.secret(), s, { projectId: 'demo', prNumber: 8 }, 2000)).toBe(
      false,
    );
    expect(verifyMemberSession(store.secret(), s, ENV, 1000 + MEMBER_SESSION_TTL_MS)).toBe(false);
  });
});

describe('cookies', () => {
  it('is host-only, HttpOnly, Lax, Path=/', () => {
    const c = buildAccessSetCookie(ACCESS_COOKIE, 'tok', { secure: true, maxAgeMs: 90_000 });
    expect(c).toBe('ah_pr_env=tok; Path=/; Max-Age=90; HttpOnly; SameSite=Lax; Secure');
    expect(c).not.toMatch(/Domain=/i);
    expect(
      buildAccessSetCookie(ACCESS_COOKIE, 'tok', { secure: false, maxAgeMs: 1000 }),
    ).not.toMatch(/Secure/);
  });

  it('strips only the access cookies from what goes upstream', () => {
    expect(stripAccessCookies('a=1; ah_pr_env=x; ah_pr_env_pw=y; b=2')).toBe('a=1; b=2');
    expect(stripAccessCookies('ah_pr_env=x')).toBeUndefined();
    expect(stripAccessCookies(undefined)).toBeUndefined();
  });

  it('a password unlock dies when the password changes', async () => {
    const store = freshStore();
    const link = mkLink(store, 1000);
    const token = shareTokenFor(store.secret(), link);
    store.setPassword('demo', await hashPassword('hunter22'), 1100);
    const unlock = mintPasswordUnlock(store.secret(), 'demo', 1100, 1200);
    const cookie = `${ACCESS_COOKIE}=${token}; ${PASSWORD_COOKIE}=${unlock}`;
    expect(decideAccess(store, `${ACCESS_COOKIE}=${token}`, ENV, 1300)).toEqual({
      ok: false,
      reason: 'password',
    });
    expect(decideAccess(store, cookie, ENV, 1300)).toEqual({ ok: true, kind: 'share' });
    store.setPassword('demo', await hashPassword('changed!'), 1400);
    expect(decideAccess(store, cookie, ENV, 1500)).toEqual({ ok: false, reason: 'password' });
  });
});

// End to end through the ingress: a stand-in PR app behind the real proxy.
describe('gated ingress', () => {
  const BASE = 'preview.agenthub.example.com';
  const host = (pr: number) => `pr-${pr}--demo.${BASE}`;
  let store: PrEnvironmentShareStore;
  let clock = 10_000;
  let upstream: http.Server;
  let upstreamWss: WebSocketServer;
  let hub: http.Server;
  let hubUrl: string;
  const seenCookies: Array<string | undefined> = [];
  let records: Map<string, PrEnvironmentIngressRecord>;
  let failLookup = false;
  let failStore = false;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seenCookies.push(req.headers.cookie);
      res.setHeader('content-type', 'text/plain');
      res.end(`app:${req.url}`);
    });
    upstreamWss = new WebSocketServer({ server: upstream });
    upstreamWss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${String(m)}`)));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    records = new Map([
      ['demo#7', { projectId: 'demo', status: 'ready', upstreamUrl, stopReason: null }],
      ['demo#8', { projectId: 'demo', status: 'ready', upstreamUrl, stopReason: null }],
    ]);
    const gate = createPrEnvironmentAccessGate({
      store: () => {
        if (failStore) throw new Error('SQLITE_BUSY');
        return store;
      },
      sendPage: sendStatusPage,
      hubPrUrl: (env) => `https://hub.example.com/projects/${env.projectId}/pulls/${env.prNumber}`,
      verifyPassword,
      now: () => clock,
    });
    const deps = {
      getBase: () => BASE,
      lookup: ({ projectLabel, prNumber }: { projectLabel: string; prNumber: number }) => {
        if (failLookup) throw new Error('SQLITE_BUSY');
        return records.get(`${projectLabel}#${prNumber}`) ?? null;
      },
      gate,
    };
    const a = express();
    a.set('trust proxy', true);
    a.use(createPrEnvironmentProxyMiddleware(deps));
    a.use((_req, res) => res.status(200).send('hub'));
    hub = http.createServer(a);
    attachPrEnvironmentUpgrade(hub, deps);
    await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
    hubUrl = `http://127.0.0.1:${(hub.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    upstreamWss.close();
    await new Promise((r) => hub.close(r));
    await new Promise((r) => upstream.close(r));
  });

  beforeEach(() => {
    store = freshStore();
    clock = 10_000;
    seenCookies.length = 0;
    failLookup = false;
    failStore = false;
    resetMemberTicketsForTest();
  });

  it('a failed lookup is a retryable 503, not "no environment"', async () => {
    failLookup = true;
    const res = await request(hubUrl).get('/').set('Host', host(7));
    expect(res.status).toBe(503);
    expect(res.text).toContain('Temporarily unavailable');
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('a failed access check is a retryable 503, never the app', async () => {
    const token = shareTokenFor(store.secret(), mkLink(store, clock));
    failStore = true;
    const res = await request(hubUrl)
      .get('/')
      .set('Host', host(7))
      .set('Cookie', `${ACCESS_COOKIE}=${token}`);
    expect(res.status).toBe(503);
    expect(seenCookies).toHaveLength(0);
    const wsStatus = await new Promise<number>((resolve) => {
      const ws = new WebSocket(hubUrl.replace('http', 'ws'), {
        headers: { Host: host(7), Cookie: `${ACCESS_COOKIE}=${token}` },
      });
      ws.on('unexpected-response', (_req, r) => resolve(r.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(wsStatus).toBe(503);
  });

  const cookieFrom = (setCookie: string[] | string | undefined, name: string) => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const hit = list.find((c) => c.startsWith(`${name}=`));
    return hit ? hit.split(';')[0] : null;
  };

  it('a logged-out browser gets the access page, never the app', async () => {
    const res = await request(hubUrl).get('/').set('Host', host(7));
    expect(res.status).toBe(401);
    expect(res.text).toContain('Access required');
    expect(res.text).toContain('https://hub.example.com/projects/demo/pulls/7');
    expect(seenCookies).toHaveLength(0);
  });

  it('a valid share link sets a host-only cookie, drops the token from the URL, then serves the app', async () => {
    const token = shareTokenFor(store.secret(), mkLink(store, clock));
    const first = await request(hubUrl).get(`/docs?x=1&share=${token}`).set('Host', host(7));
    expect(first.status).toBe(303);
    expect(first.headers.location).toBe('/docs?x=1');
    const setCookie = first.headers['set-cookie'] as unknown as string[];
    expect(setCookie[0]).toMatch(/^ah_pr_env=.*; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/);
    expect(setCookie[0]).not.toMatch(/Domain=/i);

    const cookie = cookieFrom(setCookie, ACCESS_COOKIE)!;
    const app = await request(hubUrl)
      .get('/docs?x=1')
      .set('Host', host(7))
      .set('Cookie', `${cookie}; theme=dark`);
    expect(app.status).toBe(200);
    expect(app.text).toBe('app:/docs?x=1');
    // The app sees its own cookies but never the share token.
    expect(seenCookies).toEqual(['theme=dark']);
  });

  it('marks the cookie Secure behind TLS', async () => {
    const token = shareTokenFor(store.secret(), mkLink(store, clock));
    const res = await request(hubUrl)
      .get(`/?share=${token}`)
      .set('Host', host(7))
      .set('X-Forwarded-Proto', 'https');
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/; Secure$/);
  });

  it('a revoked link gets the access page, even with the cookie already set', async () => {
    const link = mkLink(store, clock);
    const token = shareTokenFor(store.secret(), link);
    store.revoke(link.id, 'admin', clock);
    const viaLink = await request(hubUrl).get(`/?share=${token}`).set('Host', host(7));
    expect(viaLink.status).toBe(403);
    expect(viaLink.text).toContain('revoked');
    const viaCookie = await request(hubUrl)
      .get('/')
      .set('Host', host(7))
      .set('Cookie', `${ACCESS_COOKIE}=${token}`);
    expect(viaCookie.status).toBe(403);
    expect(seenCookies).toHaveLength(0);
  });

  it('an expired link gets the access page', async () => {
    const token = shareTokenFor(store.secret(), mkLink(store, clock, { hours: 1 }));
    clock += 2 * HOUR;
    const res = await request(hubUrl).get(`/?share=${token}`).set('Host', host(7));
    expect(res.status).toBe(403);
    expect(res.text).toContain('Link expired');
  });

  it("one environment's token does not open another", async () => {
    const token = shareTokenFor(store.secret(), mkLink(store, clock, { pr: 7 }));
    const viaLink = await request(hubUrl).get(`/?share=${token}`).set('Host', host(8));
    expect(viaLink.status).toBe(403);
    const viaCookie = await request(hubUrl)
      .get('/')
      .set('Host', host(8))
      .set('Cookie', `${ACCESS_COOKIE}=${token}`);
    expect(viaCookie.status).toBe(403);
  });

  it('a member ticket opens the environment once', async () => {
    const ticket = mintMemberTicket(store, ENV, 'u1', clock);
    const first = await request(hubUrl).get(`/?share=${ticket}`).set('Host', host(7));
    expect(first.status).toBe(303);
    const cookie = cookieFrom(first.headers['set-cookie'] as unknown as string[], ACCESS_COOKIE)!;
    expect(cookie).toMatch(/^ah_pr_env=ahm_/);
    const app = await request(hubUrl).get('/').set('Host', host(7)).set('Cookie', cookie);
    expect(app.text).toBe('app:/');
    const replay = await request(hubUrl).get(`/?share=${ticket}`).set('Host', host(7));
    expect(replay.status).toBe(403);
  });

  it('refuses a ticket issued by another org', async () => {
    const otherOrg = freshStore();
    const ticket = mintMemberTicket(otherOrg, ENV, 'u1', clock);
    const res = await request(hubUrl).get(`/?share=${ticket}`).set('Host', host(7));
    expect(res.status).toBe(403);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(seenCookies).toHaveLength(0);
  });

  it('with a project password, share visitors unlock first; members are not asked', async () => {
    store.setPassword('demo', await hashPassword('hunter22'), clock);
    const token = shareTokenFor(store.secret(), mkLink(store, clock));
    const shareCookie = `${ACCESS_COOKIE}=${token}`;

    const locked = await request(hubUrl).get('/').set('Host', host(7)).set('Cookie', shareCookie);
    expect(locked.status).toBe(401);
    expect(locked.text).toContain('Password required');
    expect(locked.text).toContain(`action="${UNLOCK_PATH}"`);

    const wrong = await request(hubUrl)
      .post(UNLOCK_PATH)
      .set('Host', host(7))
      .set('Cookie', shareCookie)
      .type('form')
      .send('password=nope');
    expect(wrong.status).toBe(401);
    expect(wrong.text).toContain('Wrong password');

    const right = await request(hubUrl)
      .post(UNLOCK_PATH)
      .set('Host', host(7))
      .set('Cookie', shareCookie)
      .type('form')
      .send('password=hunter22');
    expect(right.status).toBe(303);
    const pw = cookieFrom(right.headers['set-cookie'] as unknown as string[], PASSWORD_COOKIE)!;
    const app = await request(hubUrl)
      .get('/')
      .set('Host', host(7))
      .set('Cookie', `${shareCookie}; ${pw}`);
    expect(app.text).toBe('app:/');
    // The unlock path is the ingress's own; the app never saw the form post.
    expect(seenCookies).toHaveLength(1);

    const member = mintMemberSession(store.secret(), ENV, 'u1', clock);
    const asMember = await request(hubUrl)
      .get('/')
      .set('Host', host(7))
      .set('Cookie', `${ACCESS_COOKIE}=${member}`);
    expect(asMember.text).toBe('app:/');
  });

  it('refuses a websocket upgrade without access and tunnels one with it', async () => {
    const wsUrl = hubUrl.replace('http', 'ws');
    const denied = await new Promise<number>((resolve) => {
      const ws = new WebSocket(wsUrl, { headers: { Host: host(7) } });
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => resolve(-1));
    });
    expect(denied).toBe(401);

    const token = shareTokenFor(store.secret(), mkLink(store, clock));
    const echoed = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(wsUrl, {
        headers: { Host: host(7), Cookie: `${ACCESS_COOKIE}=${token}` },
      });
      ws.on('open', () => ws.send('hi'));
      ws.on('message', (m) => {
        resolve(String(m));
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(echoed).toBe('echo:hi');
  });

  it('hosts that are not environments are untouched', async () => {
    const res = await request(hubUrl).get('/api/projects').set('Host', 'hub.example.com');
    expect(res.text).toBe('hub');
  });
});
