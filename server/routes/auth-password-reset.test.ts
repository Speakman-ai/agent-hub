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

const emailSenderMock = vi.hoisted(() => ({
  buildPasswordResetUrl: vi.fn(
    (token: string) => `https://configured.example/reset?token=${encodeURIComponent(token)}`,
  ),
  buildOwnerPasswordResetUrl: vi.fn(
    (token: string) => `https://configured.example/reset?token=${encodeURIComponent(token)}`,
  ),
  sendPasswordResetEmail: vi.fn(async () => ({ sent: true })),
}));

vi.mock('../config.js', () => ({ default: mockConfig, fileConfig: { smtp: { enabled: false } } }));
vi.mock('../email-sender.js', () => emailSenderMock);

const { default: createAuthRoutes } = await import('./auth.js');
const { authMiddleware } = await import('../auth.js');
const { setAuthFilePathForTests, reloadAuthRecord } = await import('../auth-store.js');
const { initOrgsDb, setOrgsDbPathForTests, getOrgsDb, updateOrg } = await import('../orgs.js');
const { getUserByUsername } = await import('../users-store.js');
const { createPasswordResetToken, consumePasswordResetTokenAndUpdatePassword } =
  await import('../password-resets-store.js');

function buildGatedApp(opts: Parameters<typeof createAuthRoutes>[0] = {}) {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware);
  app.use(createAuthRoutes(opts));
  return app;
}

async function setupOwner(app: ReturnType<typeof buildGatedApp>) {
  const res = await supertest(app)
    .post('/api/auth/setup')
    .send({ email: 'owner@example.com', password: 'a-strong-password' });
  if (res.status !== 200) throw new Error(`setup failed: ${res.status}`);
  return res.body.token as string;
}

beforeEach(() => {
  TMP_DIR = mkdtempSync(path.join(tmpdir(), 'auth-password-reset-test-'));
  setAuthFilePathForTests(path.join(TMP_DIR, 'auth.json'));
  setOrgsDbPathForTests(path.join(TMP_DIR, 'orgs.db'));
  initOrgsDb();
  updateOrg('default', { mode: 'remote' });
  reloadAuthRecord();
  mockConfig.apiKey = null;
  emailSenderMock.buildPasswordResetUrl.mockClear();
  emailSenderMock.sendPasswordResetEmail.mockClear();
});

describe('password reset routes', () => {
  it('issues enumeration-safe forgot-password responses without trusting request Origin', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    await setupOwner(app);

    const known = await supertest(app)
      .post('/api/auth/forgot-password')
      .set('Origin', 'https://attacker.example')
      .send({ email: 'owner@example.com' });
    const unknown = await supertest(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'nobody@example.com' });

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(known.body).toEqual({ ok: true });
    expect(unknown.body).toEqual({ ok: true });

    const rows = getOrgsDb().prepare('SELECT * FROM password_resets').all() as Array<{
      token_hash: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(emailSenderMock.buildPasswordResetUrl).toHaveBeenCalledWith(expect.any(String));
    expect(emailSenderMock.sendPasswordResetEmail).toHaveBeenCalledWith({
      to: 'owner@example.com',
      resetUrl: expect.stringMatching(/^https:\/\/configured\.example\/reset\?token=/),
    });
  });

  it('consumes a reset token once, changes the password, and rejects replay', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    await setupOwner(app);
    const user = getUserByUsername('owner@example.com')!;
    const { token } = createPasswordResetToken({ userId: user.id });

    const reset = await supertest(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'a-new-strong-password' });
    expect(reset.status).toBe(200);
    expect(reset.body).toEqual({ ok: true });

    const replay = await supertest(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'another-strong-password' });
    expect(replay.status).toBe(400);

    const oldLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-strong-password' });
    expect(oldLogin.status).toBe(401);

    const newLogin = await supertest(app)
      .post('/api/auth/login')
      .send({ email: 'owner@example.com', password: 'a-new-strong-password' });
    expect(newLogin.status).toBe(200);
  });

  it('rejects expired tokens without consuming them', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    await setupOwner(app);
    const user = getUserByUsername('owner@example.com')!;
    const { token, row } = createPasswordResetToken({ userId: user.id });
    getOrgsDb()
      .prepare('UPDATE password_resets SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), row.id);

    const reset = await supertest(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'a-new-strong-password' });
    expect(reset.status).toBe(400);

    const stored = getOrgsDb()
      .prepare('SELECT consumed_at FROM password_resets WHERE id = ?')
      .get(row.id) as { consumed_at: string | null };
    expect(stored.consumed_at).toBeNull();
  });

  it('does not consume a token when the password update fails', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    await setupOwner(app);
    const user = getUserByUsername('owner@example.com')!;
    const { token, row } = createPasswordResetToken({ userId: user.id });
    getOrgsDb()
      .prepare(
        `CREATE TRIGGER fail_password_reset_update
         BEFORE UPDATE OF password_hash ON users
         BEGIN
           SELECT RAISE(ABORT, 'forced password update failure');
         END`,
      )
      .run();

    expect(() => consumePasswordResetTokenAndUpdatePassword(token, 'new-hash')).toThrow(
      'forced password update failure',
    );

    const stored = getOrgsDb()
      .prepare('SELECT consumed_at FROM password_resets WHERE id = ?')
      .get(row.id) as { consumed_at: string | null };
    expect(stored.consumed_at).toBeNull();

    getOrgsDb().prepare('DROP TRIGGER fail_password_reset_update').run();

    const retry = consumePasswordResetTokenAndUpdatePassword(token, 'new-hash');
    expect(retry?.id).toBe(row.id);
  });

  it('invalidates existing JWTs after reset', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    const oldToken = await setupOwner(app);
    const user = getUserByUsername('owner@example.com')!;
    const { token } = createPasswordResetToken({ userId: user.id });

    const before = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(before.status).toBe(200);

    const reset = await supertest(app)
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'a-new-strong-password' });
    expect(reset.status).toBe(200);

    const after = await supertest(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${oldToken}`);
    expect(after.status).toBe(401);
  });

  it('lets Owners generate a reset token for no-email installs', async () => {
    const app = buildGatedApp({ disableRateLimit: true });
    const ownerToken = await setupOwner(app);
    const user = getUserByUsername('owner@example.com')!;

    const res = await supertest(app)
      .post(`/api/auth/users/${user.id}/reset-token`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({});
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.url).toMatch(/^https:\/\/configured\.example\/reset\?token=/);
    expect(res.body.expiresAt).toBeTypeOf('string');
  });

  it('rate-limits forgot-password by IP', async () => {
    const app = buildGatedApp({ forgotPasswordRateLimit: { windowMs: 60_000, limit: 2 } });
    await setupOwner(app);

    for (let i = 0; i < 2; i += 1) {
      const res = await supertest(app)
        .post('/api/auth/forgot-password')
        .send({ email: 'owner@example.com' });
      expect(res.status).toBe(200);
    }

    const blocked = await supertest(app)
      .post('/api/auth/forgot-password')
      .send({ email: 'owner@example.com' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
  });

  it('rate-limits reset-password attempts before token work can be abused', async () => {
    const app = buildGatedApp({ resetPasswordRateLimit: { windowMs: 60_000, limit: 2 } });
    await setupOwner(app);

    for (let i = 0; i < 2; i += 1) {
      const res = await supertest(app)
        .post('/api/auth/reset-password')
        .send({ token: `not-a-real-token-${i}`, newPassword: 'a-new-strong-password' });
      expect(res.status).toBe(400);
    }

    const blocked = await supertest(app)
      .post('/api/auth/reset-password')
      .send({ token: 'not-a-real-token-3', newPassword: 'a-new-strong-password' });
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'rate_limited' });
  });
});
