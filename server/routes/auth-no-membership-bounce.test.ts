/**
 * Regression tests for the "new user gets login success but is kicked back
 * to login" report.
 *
 * A user who authenticates successfully at the password layer but is not a
 * member of the server-wide active org must fail in a *coherent* way:
 * - login itself refuses with a 403 carrying a stable `code`, OR
 * - if the client is already holding a token (e.g. the active org changed
 *   under it, or a token minted for a different org), the middleware 403
 *   carries a stable `code` so the client can clear the dead token and
 *   return to login instead of stranding on a broken app.
 *
 * Harness mirrors auth-phase3.test.ts: real Express app + real orgs.db in a
 * tmp dir so middleware/stores/routes all exercise production wiring.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';
import { tmpdir } from 'os';
import { mkdtempSync } from 'fs';
import path from 'path';

let TMP_DIR = '';
const mockConfig: { apiKey: string | null; dataDir: string } = {
  apiKey: null,
  get dataDir() {
    return TMP_DIR;
  },
} as { apiKey: string | null; dataDir: string };

vi.mock('../config.js', () => ({ default: mockConfig }));

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg, createOrg, setActiveOrgId } =
  await import('../orgs.js');
const { createUser } = await import('../users-store.js');
const { createMembership } = await import('../memberships-store.js');
const { hashPassword } = await import('../password.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
  // A trivial protected route to stand in for a bootstrap data call
  // (e.g. GET /api/projects) so we can observe what the middleware does
  // to a token-holding non-member.
  app.get('/api/_protected', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

async function setupOwner(app: ReturnType<typeof buildGatedApp>) {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'a-strong-password' });
  if (res.status !== 200)
    throw new Error(`setup failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-no-membership-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('no active-org membership → coherent failure', () => {
  it('a token-holding user whose active org changed out from under them gets a coded 403 from the middleware', async () => {
    const app = buildGatedApp();
    // Owner is a member of 'default' (the active org at setup time) and
    // holds a valid token.
    const ownerToken = await setupOwner(app);

    // Sanity: the token works while 'default' is active.
    const before = await supertest(app)
      .get('/api/_protected')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(before.status).toBe(200);

    // The server-wide active org flips to a new org the user is NOT in.
    createOrg({ id: 'org2', name: 'Org Two' });
    setActiveOrgId('org2');

    // The still-valid token now resolves to no membership in the active
    // org. The middleware must answer with a 403 carrying a stable code
    // so the client can distinguish "your session is dead, re-auth" from
    // an ordinary "you lack permission for this resource" 403.
    const after = await supertest(app)
      .get('/api/_protected')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(after.status).toBe(403);
    expect(after.body.code).toBe('no_active_org_membership');
  });

  it('login for a user with no membership in the active org refuses with code no_membership', async () => {
    const app = buildGatedApp();
    await setupOwner(app);

    // A second user must exist, otherwise login auto-seeds an Owner
    // membership for the sole user (countUsers() === 1) and the
    // no-membership branch never runs. This models a real multi-user
    // install where a missing membership is a genuine permissions state.
    const alicePw = await hashPassword('alices-super-strong-password');
    const alice = createUser({ username: 'alice@example.com', passwordHash: alicePw });
    createMembership(alice.id, 'default', 'User');

    // Flip the active org so the owner is no longer a member of it. With
    // >1 user and the owner missing from the active one, login must refuse
    // rather than mint a token that fails on the next call.
    createOrg({ id: 'org2', name: 'Org Two' });
    setActiveOrgId('org2');

    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('no_membership');
  });
});
