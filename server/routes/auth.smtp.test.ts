import type TestAgent from 'supertest/lib/agent.js';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequest } from '../test/helpers.js';
import { getOrgsDb } from '../orgs.js';

const nodemailerMocks = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { createTransportMock, sendMailMock };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: nodemailerMocks.createTransportMock },
  createTransport: nodemailerMocks.createTransportMock,
}));

let request: TestAgent;
let ownerToken = '';
let ownerId = '';

beforeAll(async () => {
  request = await getRequest();
  const setup = await request
    .post('/api/auth/setup')
    .send({ username: 'owner@example.com', password: 'owner-password-123' })
    .expect(200);
  ownerToken = setup.body.token;
  ownerId = setup.body.user.id;
});

beforeEach(async () => {
  nodemailerMocks.createTransportMock.mockClear();
  nodemailerMocks.sendMailMock.mockReset();
  nodemailerMocks.sendMailMock.mockResolvedValue({ accepted: ['new@example.com'] });
  await request
    .patch('/api/config/smtp')
    .set('Authorization', `Bearer ${ownerToken}`)
    .send({
      enabled: false,
      host: '',
      port: 587,
      tlsMode: 'starttls',
      username: null,
      password: null,
      from: '',
    })
    .expect(200);
});

describe('auth routes SMTP integration', () => {
  it('creates invites without email delivery when SMTP is not configured', async () => {
    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'new@example.com', role: 'User' })
      .expect(201);

    expect(invite.body.emailDelivery).toEqual({
      attempted: false,
      sent: false,
      reason: 'smtp_not_configured',
    });
    expect(invite.body.url).toContain(`/invite/${invite.body.token}`);
    expect(nodemailerMocks.sendMailMock).not.toHaveBeenCalled();
  });

  it('sends invite email through the shared sender when SMTP is configured', async () => {
    await request
      .patch('/api/config/smtp')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        username: 'mailer@example.com',
        password: 'stored-secret',
        from: 'agenthub@example.com',
      })
      .expect(200);

    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'new@example.com', role: 'Admin' })
      .expect(201);

    expect(invite.body.emailDelivery).toEqual({ attempted: true, sent: true });
    expect(nodemailerMocks.sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'agenthub@example.com',
        to: 'new@example.com',
        subject: expect.stringContaining('invited'),
        text: expect.stringContaining(invite.body.url),
      }),
    );
  });

  it('resends active invite email and reports SMTP availability to Members UI', async () => {
    await request
      .patch('/api/config/smtp')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        username: 'mailer@example.com',
        password: 'stored-secret',
        from: 'agenthub@example.com',
      })
      .expect(200);

    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'resend@example.com', role: 'User' })
      .expect(201);
    nodemailerMocks.sendMailMock.mockClear();

    const sent = await request
      .post(`/api/auth/invites/${invite.body.token}/email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(sent.body).toMatchObject({
      ok: true,
      invite: { token: invite.body.token, email: 'resend@example.com' },
      emailDelivery: { attempted: true, sent: true },
    });
    expect(sent.body.invite.url).toContain(`/invite/${invite.body.token}`);
    expect(nodemailerMocks.sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'resend@example.com',
        text: expect.stringContaining(`/invite/${invite.body.token}`),
      }),
    );

    const listed = await request
      .get('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(listed.body.emailDelivery).toEqual({ smtpConfigured: true });
    expect(listed.body.invites[0]).toHaveProperty('url');
  });

  it('requires Admin role to resend invite email', async () => {
    const createdUser = await request
      .post('/api/auth/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: 'invite-email-user@example.com',
        password: 'member-password-123',
        role: 'User',
      })
      .expect(201);
    const login = await request
      .post('/api/auth/login')
      .send({ email: createdUser.body.user.email, password: 'member-password-123' })
      .expect(200);
    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'blocked-resend@example.com', role: 'User' })
      .expect(201);

    await request
      .post(`/api/auth/invites/${invite.body.token}/email`)
      .set('Authorization', `Bearer ${login.body.token}`)
      .expect(403);
  });

  it('rejects expired and consumed invites before sending email', async () => {
    const expired = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'expired@example.com', role: 'User' })
      .expect(201);
    getOrgsDb()
      .prepare('UPDATE invites SET expires_at = ? WHERE token = ?')
      .run('2000-01-01T00:00:00.000Z', expired.body.token);

    await request
      .post(`/api/auth/invites/${expired.body.token}/email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(410);

    const consumed = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'consumed@example.com', role: 'User' })
      .expect(201);
    await request
      .post(`/api/auth/invites/${consumed.body.token}/accept`)
      .send({ email: 'consumed@example.com', password: 'member-password-123' })
      .expect(201);

    await request
      .post(`/api/auth/invites/${consumed.body.token}/email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(410);
    expect(nodemailerMocks.sendMailMock).not.toHaveBeenCalled();
  });

  it('returns copy-link fallback when SMTP is unavailable for resend', async () => {
    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'fallback@example.com', role: 'User' })
      .expect(201);

    const sent = await request
      .post(`/api/auth/invites/${invite.body.token}/email`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    expect(sent.body.error).toMatch(/copy the invite link/i);
    expect(sent.body.error).not.toContain(invite.body.token);
    expect(nodemailerMocks.sendMailMock).not.toHaveBeenCalled();
  });

  it('returns safe SMTP failure errors without leaking secrets or invite tokens', async () => {
    const invite = await request
      .post('/api/auth/invites')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: 'safe-error@example.com', role: 'User' })
      .expect(201);
    await request
      .patch('/api/config/smtp')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 587,
        tlsMode: 'starttls',
        username: 'mailer@example.com',
        password: 'stored-secret',
        from: 'agenthub@example.com',
      })
      .expect(200);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nodemailerMocks.sendMailMock.mockRejectedValueOnce(
      new Error(`bad auth stored-secret ${invite.body.token}`),
    );
    try {
      const sent = await request
        .post(`/api/auth/invites/${invite.body.token}/email`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .expect(502);

      expect(sent.body.error).toMatch(/could not be sent/i);
      expect(JSON.stringify(sent.body)).not.toContain('stored-secret');
      expect(JSON.stringify(sent.body)).not.toContain(invite.body.token);
      const logged = warnSpy.mock.calls.map((call) => call.join(' ')).join('\n');
      expect(logged).not.toContain('stored-secret');
      expect(logged).not.toContain(invite.body.token);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('exposes password-reset delivery status so clients can show the owner reset-code fallback', async () => {
    const reset = await request
      .post(`/api/auth/users/${ownerId}/password`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ newPassword: 'new-owner-password-123' })
      .expect(200);

    expect(reset.body.passwordReset).toEqual({
      smtpConfigured: false,
      fallbackAvailable: true,
      fallback: 'owner_generated_reset_code',
    });
  });
});
