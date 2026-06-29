import type TestAgent from 'supertest/lib/agent.js';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRequest } from '../test/helpers.js';
import { resolveSmtpTestRecipient } from './config.js';

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

beforeAll(async () => {
  request = await getRequest();
});

beforeEach(async () => {
  nodemailerMocks.createTransportMock.mockClear();
  nodemailerMocks.sendMailMock.mockReset();
  nodemailerMocks.sendMailMock.mockResolvedValue({ accepted: ['owner@example.com'] });

  await request.patch('/api/config/smtp').send({
    enabled: false,
    host: '',
    port: 587,
    tlsMode: 'starttls',
    username: null,
    password: null,
    from: '',
  });
});

function readFileConfig(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(path.join(process.env.AGENT_HUB_DATA_DIR!, 'config.json'), 'utf-8'),
  );
}

function configPath(): string {
  return path.join(process.env.AGENT_HUB_DATA_DIR!, 'config.json');
}

describe('SMTP settings routes', () => {
  it('persists SMTP settings, masks secrets on read, and preserves the password on partial update', async () => {
    const saved = await request
      .patch('/api/config/smtp')
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: '587',
        tlsMode: 'starttls',
        username: 'mailer@example.com',
        password: 'stored-secret',
        from: 'agenthub@example.com',
      })
      .expect(200);

    expect(saved.body.smtp).toMatchObject({
      enabled: true,
      host: 'smtp.example.com',
      port: 587,
      tlsMode: 'starttls',
      username: 'mailer@example.com',
      password: '••••••••',
      passwordSet: true,
      configured: true,
      from: 'agenthub@example.com',
    });
    expect((readFileConfig().smtp as Record<string, unknown>).password).toBe('stored-secret');

    await request
      .patch('/api/config/smtp')
      .send({ host: 'smtp2.example.com', password: '••••••••' })
      .expect(200);
    expect((readFileConfig().smtp as Record<string, unknown>).password).toBe('stored-secret');

    const maskedRead = await request.get('/api/config/smtp').expect(200);
    expect(maskedRead.body.smtp.password).toBe('••••••••');
    expect(maskedRead.body.passwordReset).toEqual({
      smtpConfigured: true,
      fallbackAvailable: false,
      fallback: null,
    });

    const cleared = await request.patch('/api/config/smtp').send({ password: null }).expect(200);
    expect(cleared.body.smtp.passwordSet).toBe(false);
    expect((readFileConfig().smtp as Record<string, unknown>).password).toBeNull();
  });

  it('does not expose SMTP metadata on the broad config response', async () => {
    await request
      .patch('/api/config/smtp')
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

    const broadConfig = await request.get('/api/config').expect(200);
    expect(broadConfig.body).not.toHaveProperty('smtp');
  });

  it('rejects invalid settings before writing them', async () => {
    const invalid = await request
      .patch('/api/config/smtp')
      .send({ enabled: true, host: '', from: 'not-email' })
      .expect(400);

    expect(invalid.body.error).toMatch(/host is required|from must be a valid email/i);
  });

  it('does not overwrite an unreadable existing config file when saving SMTP settings', async () => {
    const corrupted = '{"claudeBin":"/custom/claude",';
    writeFileSync(configPath(), corrupted, 'utf-8');

    try {
      const res = await request
        .patch('/api/config/smtp')
        .send({
          enabled: true,
          host: 'smtp.example.com',
          port: 587,
          tlsMode: 'starttls',
          username: 'mailer@example.com',
          password: 'stored-secret',
          from: 'agenthub@example.com',
        })
        .expect(500);

      expect(res.body.error).toMatch(/unable to read existing config\.json/i);
      expect(readFileSync(configPath(), 'utf-8')).toBe(corrupted);
    } finally {
      writeFileSync(configPath(), '{}', 'utf-8');
    }
  });

  it('reports unconfigured SMTP test sends without touching Nodemailer', async () => {
    const res = await request
      .post('/api/config/smtp/test')
      .send({ to: 'owner@example.com' })
      .expect(400);

    expect(res.body).toEqual({
      error: 'SMTP is not configured or enabled.',
      code: 'smtp_not_configured',
    });
    expect(nodemailerMocks.createTransportMock).not.toHaveBeenCalled();
  });

  it('sends a test email through configured SMTP without exposing secrets on failure', async () => {
    await request
      .patch('/api/config/smtp')
      .send({
        enabled: true,
        host: 'smtp.example.com',
        port: 465,
        tlsMode: 'ssl',
        username: 'mailer@example.com',
        password: 'stored-secret',
        from: 'agenthub@example.com',
      })
      .expect(200);

    const success = await request
      .post('/api/config/smtp/test')
      .send({ to: 'owner@example.com' })
      .expect(200);

    expect(success.body).toEqual({ ok: true, to: 'owner@example.com' });
    expect(nodemailerMocks.createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      requireTLS: false,
      auth: { user: 'mailer@example.com', pass: 'stored-secret' },
    });
    expect(nodemailerMocks.sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'agenthub@example.com',
        to: 'owner@example.com',
        subject: 'Agent Hub SMTP test',
      }),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nodemailerMocks.sendMailMock.mockRejectedValueOnce(
      new Error('bad credentials mailer@example.com stored-secret'),
    );
    const failure = await request
      .post('/api/config/smtp/test')
      .send({ to: 'owner@example.com' })
      .expect(502);
    expect(JSON.stringify(failure.body)).not.toContain('stored-secret');
    expect(warn.mock.calls.map((call) => call.join(' ')).join('\n')).not.toContain('stored-secret');
    warn.mockRestore();
  });
});

describe('resolveSmtpTestRecipient', () => {
  it('defaults to the current user and lets only Owners target other addresses', () => {
    expect(
      resolveSmtpTestRecipient({
        callerRole: 'Admin',
        callerEmail: 'admin@example.com',
      }),
    ).toEqual({ ok: true, to: 'admin@example.com' });
    expect(
      resolveSmtpTestRecipient({
        requestedTo: 'other@example.com',
        callerRole: 'Admin',
        callerEmail: 'admin@example.com',
      }),
    ).toMatchObject({ ok: false, status: 403 });
    expect(
      resolveSmtpTestRecipient({
        requestedTo: 'other@example.com',
        callerRole: 'Owner',
        callerEmail: null,
      }),
    ).toEqual({ ok: true, to: 'other@example.com' });
    expect(
      resolveSmtpTestRecipient({
        requestedTo: 'bad-address',
        callerRole: 'Owner',
        callerEmail: null,
      }),
    ).toMatchObject({ ok: false, status: 400 });
  });
});
