/**
 * Integration tests for the preview iframe auth bridge:
 *
 *   POST /api/sessions/:id/preview/ticket          (mint single-use ticket)
 *   GET  /api/sessions/:id/preview/proxy?ticket=…  (consume + set cookie)
 *   GET  /api/sessions/:id/preview/proxy/<sub>     (cookie auth path)
 *
 * The proxy handler itself replies 503 when no preview is running for
 * the session — that's fine for these tests, which only need to assert
 * that the auth gate accepts/rejects the right callers. 503 means
 * "auth passed, no upstream"; 401/403/404 means "auth gate did its
 * job". The two outcomes are clearly distinguishable.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import './setup.js';
import type supertest from 'supertest';
import { getRequest } from './helpers.js';
import { saveAuthRecord, generateJwtSecret } from '../auth-store.js';
import { signJwt } from '../jwt.js';
import { createUser } from '../users-store.js';
import { createMembership } from '../memberships-store.js';
import { getActiveOrgId } from '../orgs.js';
import { resetPreviewAuthStoresForTest } from '../preview-auth.js';

let request: supertest.Agent;
let ownerJwt: string;
let otherJwt: string;
let projectId: string;
let agentId: string;
let sessionId: string;

async function createSessionAs(jwt: string, name: string): Promise<string> {
  const res = await request
    .post(`/api/agents/${agentId}/sessions`)
    .set('Authorization', `Bearer ${jwt}`)
    .send({ name });
  if (res.status >= 300) {
    throw new Error(
      `Session create failed for "${name}": ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body.id as string;
}

beforeAll(async () => {
  request = await getRequest();
  const jwtSecret = generateJwtSecret();
  saveAuthRecord({
    username: 'preview-ticket-bootstrap',
    passwordHash: 'scrypt$ignored',
    jwtSecret,
    role: 'Owner',
  });
  const orgId = getActiveOrgId();

  const ownerRow = createUser({
    username: `preview-ticket-owner-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-01T00:00:00Z',
  });
  createMembership(ownerRow.id, orgId, 'Owner');
  ownerJwt = signJwt(ownerRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'Owner', uid: ownerRow.id },
  });

  const otherRow = createUser({
    username: `preview-ticket-other-${Date.now()}`,
    passwordHash: 'h',
    createdAt: '2026-01-02T00:00:00Z',
  });
  createMembership(otherRow.id, orgId, 'User');
  otherJwt = signJwt(otherRow.username, jwtSecret, {
    expiresInSec: 60 * 60,
    claims: { role: 'User', uid: otherRow.id },
  });

  // Create the project / agent / session as the owner so the
  // ownership predicate matches.
  projectId = `pti-proj-${Date.now()}`;
  await request
    .post('/api/projects')
    .set('Authorization', `Bearer ${ownerJwt}`)
    .send({ id: projectId, name: projectId, cwd: '/tmp', color: '#3B82F6' })
    .expect(201);

  agentId = `pti-agent-${Date.now()}`;
  await request
    .post('/api/agents')
    .set('Authorization', `Bearer ${ownerJwt}`)
    .send({ id: agentId, projectId, name: agentId, engine: 'claude-code' })
    .expect(201);

  sessionId = await createSessionAs(ownerJwt, 'pti-sess');
}, 60_000);

beforeEach(() => {
  resetPreviewAuthStoresForTest();
});

describe('POST /api/sessions/:id/preview/ticket', () => {
  it('mints a ticket for the session owner', async () => {
    const res = await request
      .post(`/api/sessions/${sessionId}/preview/ticket`)
      .set('Authorization', `Bearer ${ownerJwt}`)
      .expect(200);
    expect(typeof res.body.ticket).toBe('string');
    expect(res.body.ticket.startsWith('ahpt_')).toBe(true);
    expect(res.body.ttlSeconds).toBeGreaterThan(0);
    expect(res.body.ttlSeconds).toBeLessThanOrEqual(60);
  });

  it('404s for a non-owner caller', async () => {
    await request
      .post(`/api/sessions/${sessionId}/preview/ticket`)
      .set('Authorization', `Bearer ${otherJwt}`)
      .expect(404);
  });

  it('401s when called with no credential', async () => {
    await request.post(`/api/sessions/${sessionId}/preview/ticket`).expect(401);
  });
});

describe('preview proxy iframe auth', () => {
  async function mintTicket(jwt = ownerJwt): Promise<string> {
    const res = await request
      .post(`/api/sessions/${sessionId}/preview/ticket`)
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    return res.body.ticket as string;
  }

  function extractPreviewCookie(setCookieHeader: unknown, sid: string): string | undefined {
    const arr: string[] = Array.isArray(setCookieHeader)
      ? (setCookieHeader as string[])
      : typeof setCookieHeader === 'string'
        ? [setCookieHeader]
        : [];
    const cookie = arr.find((c) => c.startsWith(`ah_preview_${sid}=`));
    return cookie?.split(';')[0];
  }

  it('iframe nav with no header and no ticket → 401', async () => {
    const res = await request.get(`/api/sessions/${sessionId}/preview/proxy/`);
    expect(res.status).toBe(401);
  });

  it('manifest.webmanifest passes auth without ticket or cookie (spec omits credentials)', async () => {
    const res = await request.get(`/api/sessions/${sessionId}/preview/proxy/manifest.webmanifest`);
    // No preview running → 503, but not 401 (manifest fetch never sends cookies).
    expect(res.status).toBe(503);
  });

  it('manifest.webmanifest passes auth even for a session NOT owned by the org owner', async () => {
    // The original test above passes accidentally: `sessionId` is owned by
    // the first user, which `resolveOwnerUserId` falls back to for any
    // unauthenticated request, so the ownership middleware lets the
    // request through. Real prod sessions are typically owned by users
    // other than the org owner — without honouring
    // `authPreviewManifestBypass` in the router-level ownership middleware
    // those requests 404 with `{"error":"Session not found"}`, which the
    // browser then parses as a manifest ("Manifest: Line 1, column 1,
    // Syntax error"). This test exercises that path.
    const nonOwnerSid = await createSessionAs(otherJwt, 'pti-sess-non-owner');
    const res = await request.get(
      `/api/sessions/${nonOwnerSid}/preview/proxy/manifest.webmanifest`,
    );
    expect(res.status).toBe(503);
  });

  it('iframe nav with valid ticket → passes auth, sets path-scoped cookie', async () => {
    const ticket = await mintTicket();
    const res = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    // No preview running for this session in the test harness → 503.
    // The key assertion is that we got PAST auth (not 401/403).
    expect(res.status).toBe(503);
    const setCookie = res.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookieHeaderArr: string[] = Array.isArray(setCookie)
      ? (setCookie as string[])
      : [String(setCookie)];
    const previewCookie = cookieHeaderArr.find((c) => c.startsWith(`ah_preview_${sessionId}=`));
    expect(previewCookie).toBeDefined();
    expect(previewCookie).toContain('HttpOnly');
    expect(previewCookie).toContain('SameSite=Strict');
    expect(previewCookie).toContain(
      `Path=/api/sessions/${encodeURIComponent(sessionId)}/preview/proxy/`,
    );
  });

  it('the same ticket cannot be replayed — single use', async () => {
    const ticket = await mintTicket();
    // First use succeeds (503 = past auth).
    await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`).expect(503);
    // Second use → ticket gone, no cookie set this time, 401 from auth.
    const second = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    expect(second.status).toBe(401);
  });

  it('stale ticket in the URL does not shadow a valid cookie (iframe reload after consume)', async () => {
    // First load consumes the ticket and mints the path-scoped cookie.
    const ticket = await mintTicket();
    const first = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    expect(first.status).toBe(503);
    const cookiePair = extractPreviewCookie(first.headers['set-cookie'], sessionId);
    expect(cookiePair).toBeDefined();

    // A browser-initiated iframe reload re-requests the SAME document URL,
    // which still carries the now-consumed ticket, but ALSO sends the
    // path-scoped cookie. The stale ticket must NOT shadow the valid
    // cookie: auth must pass via the cookie (503 = past auth), not 401.
    // Regression for the preview-pane white-screen where pop-out worked
    // (no ticket → cookie path) but the in-pane iframe 401'd on reload.
    const reload = await request
      .get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`)
      .set('Cookie', cookiePair!);
    expect(reload.status).toBe(503);
  });

  it('stale ticket with NO cookie still 401s so the SPA re-mints', async () => {
    // Guard the other half of the fix: a consumed ticket and no cookie
    // must still fail closed (401), preserving the SPA's re-mint trigger.
    const ticket = await mintTicket();
    await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`).expect(503);
    const replay = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    expect(replay.status).toBe(401);
  });

  it('cookie set on first hit authenticates sub-resource fetches', async () => {
    const ticket = await mintTicket();
    const first = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    expect(first.status).toBe(503);
    const cookiePair = extractPreviewCookie(first.headers['set-cookie'], sessionId);
    expect(cookiePair).toBeDefined();
    // Sub-resource: no ticket, just the cookie. Must pass auth → 503.
    const sub = await request
      .get(`/api/sessions/${sessionId}/preview/proxy/main.js`)
      .set('Cookie', cookiePair!);
    expect(sub.status).toBe(503);
  });

  it('cookie from session A does not authenticate session B', async () => {
    const otherSid = await createSessionAs(ownerJwt, 'pti-sess-other');
    const ticket = await mintTicket();
    const first = await request.get(`/api/sessions/${sessionId}/preview/proxy/?ticket=${ticket}`);
    const cookiePair = extractPreviewCookie(first.headers['set-cookie'], sessionId);
    expect(cookiePair).toBeDefined();
    // The cookie name namespaces by sessionId, so the browser would
    // normally not even send it. But if a client crafted the header by
    // hand, the auth helper would look up the OTHER session's cookie
    // name and find nothing → 401.
    const sub = await request
      .get(`/api/sessions/${otherSid}/preview/proxy/main.js`)
      .set('Cookie', cookiePair!);
    expect(sub.status).toBe(401);
  });

  it('ticket minted for session A is rejected on session B', async () => {
    const otherSid = await createSessionAs(ownerJwt, 'pti-sess-other-2');
    const ticket = await mintTicket();
    const res = await request.get(`/api/sessions/${otherSid}/preview/proxy/?ticket=${ticket}`);
    expect(res.status).toBe(401);
  });

  it('Bearer header still works for proxy (Electron / server-to-server)', async () => {
    const res = await request
      .get(`/api/sessions/${sessionId}/preview/proxy/`)
      .set('Authorization', `Bearer ${ownerJwt}`);
    expect(res.status).toBe(503);
  });
});
