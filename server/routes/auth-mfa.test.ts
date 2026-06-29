import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const { default: createAuthRoutes, resetMfaAttemptBucketsForTests } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, updateOrg, createOrg } = await import('../orgs.js');
const { createMembership } = await import('../memberships-store.js');
const { createUser, getUserByUsername, getUserMfaState, getUserCredentialVersion } =
  await import('../users-store.js');
const { generateTotpCode, resetMfaChallengeStateForTests } = await import('../mfa.js');

function buildGatedApp() {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes());
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

async function enableMfaForToken(app: ReturnType<typeof buildGatedApp>, token: string) {
  const start = await supertest(app)
    .post('/api/auth/me/mfa/enrollment/start')
    .set('Authorization', `Bearer ${token}`)
    .send({});
  expect(start.status).toBe(200);
  expect(start.body.otpauthUri).toContain('otpauth://totp/');
  expect(start.body.otpauthUri).toContain('secret=');

  const confirm = await supertest(app)
    .post('/api/auth/me/mfa/enrollment/confirm')
    .set('Authorization', `Bearer ${token}`)
    .send({ code: generateTotpCode(start.body.secret) });
  expect(confirm.status).toBe(200);
  expect(confirm.body.recoveryCodes).toHaveLength(10);
  return {
    secret: start.body.secret as string,
    recoveryCodes: confirm.body.recoveryCodes as string[],
  };
}

async function loginWithMfa(
  app: ReturnType<typeof buildGatedApp>,
  opts: { email: string; password: string; code: string },
) {
  const login = await supertest(app)
    .post('/api/auth/login')
    .send({ email: opts.email, password: opts.password });
  expect(login.status).toBe(200);
  expect(login.body).toMatchObject({ mfaRequired: true });

  const finish = await supertest(app)
    .post('/api/auth/login/mfa')
    .send({ challengeId: login.body.challengeId, code: opts.code });
  expect(finish.status).toBe(200);
  expect(finish.body.token.split('.')).toHaveLength(3);
  return finish.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-mfa-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
  resetMfaAttemptBucketsForTests();
  resetMfaChallengeStateForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-29T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TOTP MFA enrollment and login challenge', () => {
  it('enables MFA, stores only hashed recovery codes, challenges login, and invalidates old JWTs', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret, recoveryCodes } = await enableMfaForToken(app, ownerToken);

    const owner = getUserByUsername('owner@example.com')!;
    const state = getUserMfaState(owner.id)!;
    expect(state.enabled).toBe(true);
    expect(state.pendingSecret).toBeNull();
    expect(state.totpSecret).toBe(secret);
    expect(state.recoveryCodeHashes).toHaveLength(10);
    expect(state.recoveryCodeHashes).not.toContain(recoveryCodes[0]);

    const staleMe = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(staleMe.status).toBe(401);

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const passwordLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(passwordLogin.status).toBe(200);
    expect(passwordLogin.body).toMatchObject({ mfaRequired: true });
    expect(passwordLogin.body.token).toBeUndefined();

    const finish = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({
        challengeId: passwordLogin.body.challengeId,
        code: generateTotpCode(secret),
      });
    expect(finish.status).toBe(200);
    expect(finish.body.token.split('.')).toHaveLength(3);
  });

  it('rejects reused recovery codes and rejects replayed TOTP steps', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret, recoveryCodes } = await enableMfaForToken(app, ownerToken);

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const loginA = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(loginA.body.mfaRequired).toBe(true);
    const recovered = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: loginA.body.challengeId, code: recoveryCodes[0] });
    expect(recovered.status).toBe(200);

    const loginB = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const reusedRecovery = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: loginB.body.challengeId, code: recoveryCodes[0] });
    expect(reusedRecovery.status).toBe(401);

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const loginC = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const code = generateTotpCode(secret);
    const ok = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: loginC.body.challengeId, code });
    expect(ok.status).toBe(200);

    const loginD = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const replay = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: loginD.body.challengeId, code });
    expect(replay.status).toBe(401);
  });

  it('rate-limits repeated MFA challenge failures', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    await enableMfaForToken(app, ownerToken);

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const login = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(login.body.mfaRequired).toBe(true);

    for (let i = 0; i < 5; i++) {
      const wrong = await supertest(app)
        .post('/api/auth/login/mfa')
        .send({ challengeId: login.body.challengeId, code: '000000' });
      expect(wrong.status).toBe(401);
    }

    const blocked = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: login.body.challengeId, code: '000000' });
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('rate_limited');
  });

  it('regenerates recovery codes after a valid second factor and invalidates prior credentials', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret, recoveryCodes } = await enableMfaForToken(app, ownerToken);
    const owner = getUserByUsername('owner@example.com')!;

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const freshToken = await loginWithMfa(app, {
      email: 'owner@example.com',
      password: 'a-strong-password',
      code: generateTotpCode(secret),
    });
    const beforeVersion = getUserCredentialVersion(owner.id)!;

    const regenerated = await supertest(app)
      .post('/api/auth/me/mfa/recovery-codes/regenerate')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ code: recoveryCodes[0] });
    expect(regenerated.status).toBe(200);
    expect(regenerated.body.recoveryCodes).toHaveLength(10);
    expect(regenerated.body.recoveryCodes).not.toContain(recoveryCodes[0]);
    expect(getUserCredentialVersion(owner.id)).toBeGreaterThan(beforeVersion);

    const staleMe = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(staleMe.status).toBe(401);

    const loginWithOldRecovery = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    const reused = await supertest(app)
      .post('/api/auth/login/mfa')
      .send({ challengeId: loginWithOldRecovery.body.challengeId, code: recoveryCodes[0] });
    expect(reused.status).toBe(401);

    const state = getUserMfaState(owner.id)!;
    expect(state.enabled).toBe(true);
    expect(state.recoveryCodeHashes).toHaveLength(10);
  });

  it('rejects invalid second factors for recovery-code regeneration without changing MFA state', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret } = await enableMfaForToken(app, ownerToken);
    const owner = getUserByUsername('owner@example.com')!;

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const freshToken = await loginWithMfa(app, {
      email: 'owner@example.com',
      password: 'a-strong-password',
      code: generateTotpCode(secret),
    });
    const before = getUserMfaState(owner.id)!;

    const rejected = await supertest(app)
      .post('/api/auth/me/mfa/recovery-codes/regenerate')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ code: '000000' });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error).toBe('Invalid MFA code');

    const after = getUserMfaState(owner.id)!;
    expect(after.enabled).toBe(true);
    expect(after.credentialVersion).toBe(before.credentialVersion);
    expect(after.recoveryCodeHashes).toEqual(before.recoveryCodeHashes);
  });

  it('disables MFA after a valid second factor and returns to password-only login', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret, recoveryCodes } = await enableMfaForToken(app, ownerToken);
    const owner = getUserByUsername('owner@example.com')!;

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const freshToken = await loginWithMfa(app, {
      email: 'owner@example.com',
      password: 'a-strong-password',
      code: generateTotpCode(secret),
    });
    const beforeVersion = getUserCredentialVersion(owner.id)!;

    const disabled = await supertest(app)
      .post('/api/auth/me/mfa/disable')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ code: recoveryCodes[0] });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ ok: true, mfaEnabled: false });
    expect(getUserCredentialVersion(owner.id)).toBeGreaterThan(beforeVersion);

    const staleMe = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${freshToken}`);
    expect(staleMe.status).toBe(401);

    const state = getUserMfaState(owner.id)!;
    expect(state.enabled).toBe(false);
    expect(state.totpSecret).toBeNull();
    expect(state.recoveryCodeHashes).toEqual([]);

    const passwordOnly = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(passwordOnly.status).toBe(200);
    expect(passwordOnly.body.token.split('.')).toHaveLength(3);
    expect(passwordOnly.body.mfaRequired).toBeUndefined();
  });

  it('rejects invalid second factors for MFA disable without changing MFA state', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const { secret } = await enableMfaForToken(app, ownerToken);
    const owner = getUserByUsername('owner@example.com')!;

    vi.setSystemTime(new Date(Date.now() + 31_000));
    const freshToken = await loginWithMfa(app, {
      email: 'owner@example.com',
      password: 'a-strong-password',
      code: generateTotpCode(secret),
    });
    const before = getUserMfaState(owner.id)!;

    const rejected = await supertest(app)
      .post('/api/auth/me/mfa/disable')
      .set('Authorization', `Bearer ${freshToken}`)
      .send({ code: '000000' });
    expect(rejected.status).toBe(401);
    expect(rejected.body.error).toBe('Invalid MFA code');

    const after = getUserMfaState(owner.id)!;
    expect(after.enabled).toBe(true);
    expect(after.credentialVersion).toBe(before.credentialVersion);
    expect(after.recoveryCodeHashes).toEqual(before.recoveryCodeHashes);
  });

  it('lets Owner/Admin reset user MFA and records reset metadata', async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const created = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'alice@example.com',
        password: 'alices-super-strong-password',
        role: 'User',
      });
    expect(created.status).toBe(201);

    const aliceLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    expect(aliceLogin.status).toBe(200);
    await enableMfaForToken(app, aliceLogin.body.token);

    const alice = getUserByUsername('alice@example.com')!;
    const owner = getUserByUsername('owner@example.com')!;
    const reset = await supertest(app)
      .post(`/api/auth/users/${alice.id}/mfa/reset`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({
      ok: true,
      userId: alice.id,
      mfaEnabled: false,
      resetByUserId: owner.id,
    });
    expect(getUserMfaState(alice.id)?.enabled).toBe(false);

    const passwordOnlyLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'alice@example.com', password: 'alices-super-strong-password' });
    expect(passwordOnlyLogin.status).toBe(200);
    expect(passwordOnlyLogin.body.token.split('.')).toHaveLength(3);
    expect(passwordOnlyLogin.body.mfaRequired).toBeUndefined();
  });

  it("rejects Admin MFA reset for users outside the admin's active org", async () => {
    const app = buildGatedApp();
    const ownerToken = await setupOwner(app);
    const createdAdmin = await supertest(app)
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'admin@example.com',
        password: 'admins-super-strong-password',
        role: 'Admin',
      });
    expect(createdAdmin.status).toBe(201);

    const adminLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'admins-super-strong-password' });
    expect(adminLogin.status).toBe(200);

    createOrg({ id: 'other-org', name: 'Other Org', mode: 'remote' });
    const outsideUser = createUser({
      username: 'outside@example.com',
      passwordHash: 'not-used-by-this-test',
    });
    createMembership(outsideUser.id, 'other-org', 'User');

    const rejected = await supertest(app)
      .post(`/api/auth/users/${outsideUser.id}/mfa/reset`)
      .set('Authorization', `Bearer ${adminLogin.body.token}`)
      .send({});
    expect(rejected.status).toBe(404);
    expect(rejected.body.error).toBe('user is not a member of this org');
    expect(getUserMfaState(outsideUser.id)?.resetAt).toBeNull();
  });
});
