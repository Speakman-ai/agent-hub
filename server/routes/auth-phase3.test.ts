/**
 * Integration tests for the Phase 3 user-management + invite routes.
 *
 * We stand up a real Express app + real orgs.db in a tmp dir so the
 * auth middleware, stores, and routes all exercise the production
 * wiring. The single shared orgs.db (set per test via
 * setOrgsDbPathForTests) means memberships, users, invites, and the
 * active-org singleton all come from one place — the same thing that
 * runs in production.
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
const { setAuthFilePathForTests, reloadAuthRecord, saveAuthRecord, getAuthRecord } =
  await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb, updateOrg } = await import('../orgs.js');
const { createUser, getUserByUsername } = await import('../users-store.js');
const { createMembership, getMembershipRole } = await import('../memberships-store.js');
const { assignedProjectIdsForUser, isProjectRestricted } =
  await import('../project-members-store.js');
const { hashPassword } = await import('../password.js');

function buildGatedApp(options: Parameters<typeof createAuthRoutes>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes(options));
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
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-phase3-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  // These integration tests validate JWT / Owner / membership auth
  // enforcement. The default-seeded org is mode='local', which would
  // short-circuit the middleware via the local-bypass (card 3d72338d)
  // and hide the gate we want to test. Flip it to 'remote' so the
  // middleware exercises the real auth path for the whole suite.
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
});

describe('POST /api/auth/users (Owner only)', () => {
  it('creates a new User and seeds membership in the active org', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email: 'alice@example.com', role: 'User' });

    const alice = getUserByUsername('alice@example.com');
    expect(alice).not.toBeNull();
    expect(getMembershipRole(alice!.id, 'default')).toBe('User');
  });

  it('rejects user creation when the caller is not Owner', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Create an Admin first.
    await supertest(app).post('/api/auth/users').set('Authorization', `Bearer ${ownerToken}`).send({
      email: 'admin@example.com',
      password: 'admins-super-strong-password',
      role: 'Admin',
    });

    // Log in as the admin to get their token.
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admins-super-strong-password' });
    const adminToken: string = login.body.token;

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        email: 'newbie@example.com',
        password: 'newbies-super-strong-password',
        role: 'User',
      });
    expect(res.status).toBe(403);
  });

  it('rejects duplicate emails', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    const dup = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'another-strong-password', role: 'User' });
    expect(dup.status).toBe(409);
  });

  it('pre-assigns the new user to the selected projects (caller-visible set)', async () => {
    const visible = new Set(['proj-a', 'proj-b']);
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => visible,
      projectExists: (id) => visible.has(id),
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'alice@example.com',
        password: 'alices-super-strong-password',
        role: 'User',
        projectIds: ['proj-a', 'proj-b', 'proj-a'], // duplicate is deduped
      });
    expect(res.status).toBe(201);
    expect(res.body.assignedProjectIds.sort()).toEqual(['proj-a', 'proj-b']);

    const alice = getUserByUsername('alice@example.com')!;
    expect([...assignedProjectIdsForUser(alice.id)].sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('rejects an inaccessible/unknown project id without creating the user', async () => {
    // 'nope' is outside the caller's visible set — must be rejected even
    // though the request is otherwise valid.
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'ghost@example.com',
        password: 'ghosts-super-strong-password',
        role: 'User',
        projectIds: ['proj-a', 'nope'],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nope');
    // The user must NOT have been created — validation runs before createUser.
    expect(getUserByUsername('ghost@example.com')).toBeNull();
  });

  it('rejects an empty-string project id with 400 rather than dropping it', async () => {
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'blank@example.com',
        password: 'blanks-super-strong-password',
        role: 'User',
        projectIds: [''],
      });
    expect(res.status).toBe(400);
    // The bad request must not create a user.
    expect(getUserByUsername('blank@example.com')).toBeNull();
  });

  it('fails closed with 500 when project validation is unavailable', async () => {
    // No resolveAssignableProjectIds / projectExists injected — a non-empty
    // projectIds must be rejected, not accepted with arbitrary ids.
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'failclosed@example.com',
        password: 'failcloseds-strong-password',
        role: 'User',
        projectIds: ['proj-a'],
      });
    expect(res.status).toBe(500);
    expect(getUserByUsername('failclosed@example.com')).toBeNull();
  });

  it('creates the user with an empty assignment list when projectIds is omitted', async () => {
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'solo@example.com', password: 'solos-super-strong-password', role: 'User' });
    expect(res.status).toBe(201);
    expect(res.body.assignedProjectIds).toEqual([]);

    const solo = getUserByUsername('solo@example.com')!;
    expect(assignedProjectIdsForUser(solo.id).size).toBe(0);
  });
});

describe('PUT /api/auth/users/:id/role (sole-Owner guard)', () => {
  it('refuses to demote the only Owner', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const owner = getUserByUsername('owner@example.com')!;

    const res = await supertest(app)
      .put(`/api/auth/users/${owner.id}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'Admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only Owner/i);
    expect(getMembershipRole(owner.id, 'default')).toBe('Owner');
  });

  it('allows Owner to promote a second user to Owner, then demote the original', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Create a User first
    const create = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'coowner@example.com', password: 'coowners-strong-password', role: 'User' });
    const coownerId = create.body.user.id;

    // Promote to Owner
    const promote = await supertest(app)
      .put(`/api/auth/users/${coownerId}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'Owner' });
    expect(promote.status).toBe(200);
    expect(getMembershipRole(coownerId, 'default')).toBe('Owner');

    // Now the original owner can be demoted.
    const original = getUserByUsername('owner@example.com')!;
    const demote = await supertest(app)
      .put(`/api/auth/users/${original.id}/role`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'Admin' });
    expect(demote.status).toBe(200);
  });
});

describe('Invite flow end-to-end', () => {
  it('Admin issues invite, stranger accepts and joins with invite role', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Create an Admin to issue the invite.
    await supertest(app).post('/api/auth/users').set('Authorization', `Bearer ${ownerToken}`).send({
      email: 'admin@example.com',
      password: 'admins-super-strong-password',
      role: 'Admin',
    });
    const adminLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admins-super-strong-password' });
    const adminToken: string = adminLogin.body.token;

    // Issue an invite.
    const invite = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'User', email: 'new@example.com' });
    expect(invite.status).toBe(201);
    const token: string = invite.body.token;
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // GET the invite landing (public).
    const landing = await supertest(app).get(`/api/auth/invites/${token}`);
    expect(landing.status).toBe(200);
    expect(landing.body).toMatchObject({ orgId: 'default', role: 'User', accepted: false });

    // Accept (public).
    const accept = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'newbie@example.com', password: 'newbies-super-strong-password' });
    expect(accept.status).toBe(201);
    expect(accept.body.user.email).toBe('newbie@example.com');
    expect(accept.body.user.role).toBe('User');
    expect(accept.body.token.split('.')).toHaveLength(3);

    const newbie = getUserByUsername('newbie@example.com')!;
    expect(getMembershipRole(newbie.id, 'default')).toBe('User');

    // Second accept should fail with 410.
    const replay = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'imposter@example.com', password: 'imposter-strong-password' });
    expect(replay.status).toBe(410);
  });

  it('rejects invite issuance with role=Owner', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const res = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'Owner' });
    expect(res.status).toBe(400);
  });

  it('returns 410 for an expired invite at accept time', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const invite = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User', ttlHours: 1 });
    const token: string = invite.body.token;

    // Force-expire the invite by writing directly to the DB.
    getOrgsDb()
      .prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run('2000-01-01T00:00:00Z', token);

    const accept = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'latecomer@example.com', password: 'latecomers-strong-password' });
    expect(accept.status).toBe(410);
  });
});

describe('Invite project pre-assignment', () => {
  it('Owner issues an invite with projectIds; acceptance assigns them', async () => {
    const existing = new Set(['proj-a', 'proj-b']);
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => existing,
      projectExists: (id) => existing.has(id),
    });
    const ownerToken = await setupOwner(app);

    const invite = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User', email: 'pm@example.com', projectIds: ['proj-a', 'proj-b', 'proj-a'] });
    expect(invite.status).toBe(201);
    expect(invite.body.projectIds.sort()).toEqual(['proj-a', 'proj-b']);
    const token: string = invite.body.token;

    const accept = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'pm-user@example.com', password: 'pm-users-strong-password' });
    expect(accept.status).toBe(201);

    const user = getUserByUsername('pm-user@example.com')!;
    expect([...assignedProjectIdsForUser(user.id)].sort()).toEqual(['proj-a', 'proj-b']);
  });

  it('skips a project deleted between invite issuance and acceptance (TOCTOU)', async () => {
    // `existing` is mutable so we can drop a project after the invite is minted
    // but before it is redeemed — the accept path must not create an ACL row
    // for the now-missing project, while the invitee still joins.
    const existing = new Set(['proj-a', 'proj-b']);
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(existing),
      projectExists: (id) => existing.has(id),
    });
    const ownerToken = await setupOwner(app);

    const invite = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User', email: 'gap@example.com', projectIds: ['proj-a', 'proj-b'] });
    expect(invite.status).toBe(201);
    const token: string = invite.body.token;

    // proj-b is deleted before the invite is accepted.
    existing.delete('proj-b');

    const accept = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'gap-user@example.com', password: 'gap-users-strong-password' });
    expect(accept.status).toBe(201);

    const user = getUserByUsername('gap-user@example.com')!;
    // Only the still-existing project is assigned; no dangling row for proj-b.
    expect([...assignedProjectIdsForUser(user.id)]).toEqual(['proj-a']);
    expect(isProjectRestricted('proj-b')).toBe(false);
  });

  it('rejects project pre-assignment from a non-Owner issuer with 403', async () => {
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    // Create + log in as an Admin.
    await supertest(app).post('/api/auth/users').set('Authorization', `Bearer ${ownerToken}`).send({
      email: 'admin@example.com',
      password: 'admins-super-strong-password',
      role: 'Admin',
    });
    const adminLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admins-super-strong-password' });
    const adminToken: string = adminLogin.body.token;

    const res = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'User', projectIds: ['proj-a'] });
    expect(res.status).toBe(403);

    // A plain invite (no projectIds) from the same Admin still works.
    const plain = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ role: 'User' });
    expect(plain.status).toBe(201);
    expect(plain.body.projectIds).toEqual([]);
  });

  it('rejects an empty-string project id on invite creation with 400', async () => {
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User', projectIds: [''] });
    expect(res.status).toBe(400);
  });

  it('rejects an inaccessible project id on invite creation with 400', async () => {
    const app = buildGatedApp({
      resolveAssignableProjectIds: () => new Set(['proj-a']),
      projectExists: (id) => id === 'proj-a',
    });
    const ownerToken = await setupOwner(app);

    const res = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User', projectIds: ['proj-a', 'nope'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('nope');
  });
});

describe('Legacy username email update', () => {
  it('rewrites a legacy username to email and clears the prompt flag', async () => {
    const app = buildGatedApp();
    const passwordHash = await hashPassword('legacy-strong-password');
    saveAuthRecord({
      username: 'legacy-owner',
      passwordHash,
      jwtSecret: 'legacy-secret',
      role: 'Owner',
    });
    const legacy = createUser({ username: 'legacy-owner', passwordHash });
    createMembership(legacy.id, 'default', 'Owner');

    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ username: 'legacy-owner', password: 'legacy-strong-password' });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: null, needsEmailUpdate: true });

    const updated = await supertest(app)
      .put('/api/auth/me/email')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ email: 'legacy@example.com' });
    expect(updated.status).toBe(200);
    expect(updated.body.user).toMatchObject({
      id: legacy.id,
      email: 'legacy@example.com',
      needsEmailUpdate: false,
      role: 'Owner',
    });
    expect(getUserByUsername('legacy-owner')).toBeNull();
    expect(getUserByUsername('legacy@example.com')?.id).toBe(legacy.id);

    const relogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'legacy@example.com', password: 'legacy-strong-password' });
    expect(relogin.status).toBe(200);
    expect(relogin.body.user.needsEmailUpdate).toBe(false);
  });

  it('does not let a normal user claim or sync the auth-record email', async () => {
    const app = buildGatedApp();
    const ownerPasswordHash = await hashPassword('owner-strong-password');
    saveAuthRecord({
      username: 'owner@example.com',
      passwordHash: ownerPasswordHash,
      jwtSecret: 'owner-secret',
      role: 'Owner',
    });
    const bobPasswordHash = await hashPassword('bob-super-strong-password');
    const bob = createUser({ username: 'bob@example.com', passwordHash: bobPasswordHash });
    createMembership(bob.id, 'default', 'User');

    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'bob@example.com', password: 'bob-super-strong-password' });
    expect(login.status).toBe(200);

    const updated = await supertest(app)
      .put('/api/auth/me/email')
      .set('Authorization', `Bearer ${login.body.token}`)
      .send({ email: 'owner@example.com' });

    expect(updated.status).toBe(409);
    expect(updated.body.error).toMatch(/email already taken/i);
    expect(getAuthRecord()?.username).toBe('owner@example.com');
    expect(getUserByUsername('bob@example.com')?.id).toBe(bob.id);
  });
});

describe('Password reset', () => {
  it('lets a user reset their own password', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    const alice = getUserByUsername('alice@example.com')!;
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    const aliceToken: string = login.body.token;

    const reset = await supertest(app)
      .post(`/api/auth/users/${alice.id}/password`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ newPassword: 'a-brand-new-strong-password' });
    expect(reset.status).toBe(200);

    // Old password should no longer log in.
    const stale = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    expect(stale.status).toBe(401);

    // New password does.
    const fresh = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'a-brand-new-strong-password' });
    expect(fresh.status).toBe(200);
  });

  it('rejects cross-user password resets from a non-Owner', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    // Create two Users.
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'bob@example.com', password: 'bobs-super-strong-password', role: 'User' });
    const bob = getUserByUsername('bob@example.com')!;
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    const aliceToken: string = login.body.token;

    const res = await supertest(app)
      .post(`/api/auth/users/${bob.id}/password`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ newPassword: 'attempted-takeover-passw0rd' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /api/auth/users/:id', () => {
  it('removes a membership and deletes the user when it was their last org', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    const alice = getUserByUsername('alice@example.com')!;

    const res = await supertest(app)
      .delete(`/api/auth/users/${alice.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userDeleted: true });
    expect(getUserByUsername('alice@example.com')).toBeNull();
  });

  it('refuses to remove the sole Owner of the active org', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const owner = getUserByUsername('owner@example.com')!;
    const res = await supertest(app)
      .delete(`/api/auth/users/${owner.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(400);
    expect(getUserByUsername('owner@example.com')).not.toBeNull();
  });
});

describe('GET /api/auth/users', () => {
  it('lists members of the active org after Phase 3 migration', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });

    const res = await supertest(app)
      .get('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.status).toBe(200);
    const emails = res.body.users.map((u: { email: string }) => u.email).sort();
    expect(emails).toEqual(['alice@example.com', 'owner@example.com']);
    const ownerRow = res.body.users.find((u: { email: string }) => u.email === 'owner@example.com');
    expect(ownerRow.role).toBe('Owner');
  });
});

// ─── Regression tests for review feedback on PR #418 ─────────────────
// Each `describe` below targets a specific blocker from the code review.
// Keep the titles self-describing so a future reader can map a reopened
// bug back to the originating finding.

describe('Regression: invites FK ON DELETE SET NULL (blocker 1)', () => {
  it('allows deleting a user who minted and accepted invites', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Owner creates an Admin who will go on to issue + accept invites.
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'inviter@example.com', password: 'inviters-strong-password', role: 'Admin' });
    const inviterLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'inviter@example.com', password: 'inviters-strong-password' });
    const inviterToken: string = inviterLogin.body.token;
    const inviter = getUserByUsername('inviter@example.com')!;

    // 1. Inviter mints an invite (populates invites.created_by).
    const mint = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${inviterToken}`)
      .send({ role: 'User' });
    expect(mint.status).toBe(201);
    const pendingToken: string = mint.body.token;

    // 2. Inviter also mints + (as a stranger) accepts a second invite
    //    so invites.accepted_by references a user we'll delete.
    //    Easiest way: accept the first invite as a new user, then have
    //    Owner delete that user — that exercises accepted_by cascade.
    const acceptorMint = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${inviterToken}`)
      .send({ role: 'User' });
    const acceptorToken: string = acceptorMint.body.token;
    const accept = await supertest(app)
      .post(`/api/auth/invites/${acceptorToken}/accept`)
      .send({ email: 'acceptor@example.com', password: 'acceptors-strong-password' });
    expect(accept.status).toBe(201);
    const acceptor = getUserByUsername('acceptor@example.com')!;

    // Sanity: both invite rows reference real user IDs.
    const invitesBefore = getOrgsDb()
      .prepare('SELECT token, created_by, accepted_by FROM invites ORDER BY created_at')
      .all() as Array<{ token: string; created_by: string | null; accepted_by: string | null }>;
    expect(invitesBefore.find((r) => r.token === pendingToken)?.created_by).toBe(inviter.id);
    expect(invitesBefore.find((r) => r.token === acceptorToken)?.accepted_by).toBe(acceptor.id);

    // 3. Delete the inviter — would have thrown a foreign-key 500 under
    //    the old schema. Should succeed cleanly under SET NULL.
    const delInviter = await supertest(app)
      .delete(`/api/auth/users/${inviter.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(delInviter.status).toBe(200);
    expect(getUserByUsername('inviter@example.com')).toBeNull();

    // 4. Delete the acceptor too — exercises accepted_by SET NULL.
    const delAcceptor = await supertest(app)
      .delete(`/api/auth/users/${acceptor.id}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(delAcceptor.status).toBe(200);

    // 5. Invite rows still exist; user columns are now NULL (audit trail
    //    preserved, dangling references gone).
    const invitesAfter = getOrgsDb()
      .prepare('SELECT token, created_by, accepted_by FROM invites')
      .all() as Array<{ token: string; created_by: string | null; accepted_by: string | null }>;
    expect(invitesAfter).toHaveLength(2);
    for (const row of invitesAfter) {
      expect(row.created_by).toBeNull();
      expect(row.accepted_by).toBeNull();
    }
  });

  it('rebuilds a pre-fix invites table (migration path)', async () => {
    // Simulate an existing dev DB with the old NO-ACTION FKs by dropping
    // the table we just created and recreating it with the broken shape,
    // then re-running initOrgsDb — the migration inside initOrgsDb should
    // detect the bad shape and rebuild it.
    const db = getOrgsDb();
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS invites;
      CREATE TABLE invites (
        token       TEXT PRIMARY KEY,
        org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
        email       TEXT,
        role        TEXT NOT NULL CHECK(role IN ('Admin','User')),
        expires_at  TEXT NOT NULL,
        created_by  TEXT NOT NULL REFERENCES users(id),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        accepted_by TEXT REFERENCES users(id),
        accepted_at TEXT
      );
    `);

    // Confirm the broken schema is in place.
    const beforeFks = db.pragma('foreign_key_list(invites)') as Array<{
      from: string;
      on_delete: string;
    }>;
    expect(beforeFks.find((fk) => fk.from === 'created_by')?.on_delete).not.toBe('SET NULL');

    // Re-run init → migration should rebuild the table.
    initOrgsDb();

    const afterFks = getOrgsDb().pragma('foreign_key_list(invites)') as Array<{
      from: string;
      on_delete: string;
    }>;
    expect(afterFks.find((fk) => fk.from === 'created_by')?.on_delete).toBe('SET NULL');
    expect(afterFks.find((fk) => fk.from === 'accepted_by')?.on_delete).toBe('SET NULL');
  });
});

describe('Regression: login rejects no-membership in a multi-user install (blocker 2)', () => {
  it('returns 403 code=no_membership instead of an unusable Owner token', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Create a second user so countUsers() > 1 — that disables the
    // sole-user auto-seed and exercises the real rejection path.
    await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password', role: 'User' });
    const alice = getUserByUsername('alice@example.com')!;

    // Yank Alice's membership — simulating "removed from org".
    getOrgsDb()
      .prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?')
      .run(alice.id, 'default');
    expect(getMembershipRole(alice.id, 'default')).toBeNull();

    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    expect(login.status).toBe(403);
    expect(login.body.code).toBe('no_membership');
    expect(login.body.token).toBeUndefined();
  });

  it('still auto-seeds Owner membership on a sole-user install', async () => {
    // No other users created — the auto-seed branch should recover a
    // missing membership rather than 403. This protects the Phase-2 →
    // Phase-3 migration story for single-user installs.
    const app = buildGatedApp();
    await setupOwner(app);
    const owner = getUserByUsername('owner@example.com')!;
    // Nuke the auto-created membership to force the recovery path.
    getOrgsDb()
      .prepare('DELETE FROM memberships WHERE user_id = ? AND org_id = ?')
      .run(owner.id, 'default');

    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('Owner');
    expect(getMembershipRole(owner.id, 'default')).toBe('Owner');
  });
});

describe('Regression: invite accept is atomic (blocker 3)', () => {
  it('rolls back user creation when markInviteAccepted loses the race', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);

    // Mint an invite, then pre-consume it so the real accept call loses
    // the `markInviteAccepted` race — that throws InviteRaceLost inside
    // the transaction, which must roll back the user + membership.
    const mint = await supertest(app)
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ role: 'User' });
    const token: string = mint.body.token;

    // Simulate another caller winning the race by pointing accepted_by
    // at a real existing user (the Owner) — markInviteAccepted's
    // `WHERE accepted_by IS NULL` clause will then refuse the second
    // caller. Using a real user id keeps the FK happy now that
    // accepted_by is enforced with ON DELETE SET NULL.
    const winner = getUserByUsername('owner@example.com')!;
    getOrgsDb()
      .prepare("UPDATE invites SET accepted_by = ?, accepted_at = datetime('now') WHERE token = ?")
      .run(winner.id, token);

    const accept = await supertest(app)
      .post(`/api/auth/invites/${token}/accept`)
      .send({ email: 'loser@example.com', password: 'losers-strong-password' });
    expect(accept.status).toBe(410);

    // The losing user row must NOT exist — the transaction should have
    // rolled it back. Under the pre-fix code this assertion fails:
    // `createUser` committed before the race was detected.
    expect(getUserByUsername('loser@example.com')).toBeNull();

    // And no membership was created either.
    const memberships = getOrgsDb().prepare('SELECT COUNT(*) as c FROM memberships').get() as {
      c: number;
    };
    // Only the Owner membership from setup remains.
    expect(memberships.c).toBe(1);
  });
});
