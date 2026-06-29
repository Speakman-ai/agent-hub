import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmtpConfig } from './types.js';

const nodemailerMocks = vi.hoisted(() => {
  const sendMailMock = vi.fn();
  const createTransportMock = vi.fn(() => ({ sendMail: sendMailMock }));
  return { createTransportMock, sendMailMock };
});

vi.mock('nodemailer', () => ({
  default: { createTransport: nodemailerMocks.createTransportMock },
  createTransport: nodemailerMocks.createTransportMock,
}));

const {
  EmailNotConfiguredError,
  getPasswordResetDeliveryStatus,
  safeEmailError,
  sendEmail,
  sendInviteEmail,
} = await import('./email-sender.js');

const smtp: SmtpConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  tlsMode: 'starttls',
  username: 'mailer@example.com',
  password: 'super-secret',
  from: 'agenthub@example.com',
};

beforeEach(() => {
  nodemailerMocks.createTransportMock.mockClear();
  nodemailerMocks.sendMailMock.mockReset();
  nodemailerMocks.sendMailMock.mockResolvedValue({ accepted: ['to@example.com'] });
});

describe('email sender', () => {
  it('reports owner reset-code fallback when SMTP config is missing', () => {
    expect(getPasswordResetDeliveryStatus(undefined)).toEqual({
      smtpConfigured: false,
      fallbackAvailable: true,
      fallback: 'owner_generated_reset_code',
    });
  });

  it('refuses to send when SMTP is not configured', async () => {
    await expect(
      sendEmail({
        to: 'to@example.com',
        subject: 'Subject',
        text: 'Body',
        smtp: { ...smtp, enabled: false },
      }),
    ).rejects.toBeInstanceOf(EmailNotConfiguredError);
    expect(nodemailerMocks.createTransportMock).not.toHaveBeenCalled();
  });

  it('sends through a provider-agnostic Nodemailer transport', async () => {
    await sendEmail({
      to: 'to@example.com',
      subject: 'Agent Hub test',
      text: 'Plain text',
      html: '<p>HTML</p>',
      smtp,
    });

    expect(nodemailerMocks.createTransportMock).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer@example.com', pass: 'super-secret' },
    });
    expect(nodemailerMocks.sendMailMock).toHaveBeenCalledWith({
      from: 'agenthub@example.com',
      to: 'to@example.com',
      subject: 'Agent Hub test',
      text: 'Plain text',
      html: '<p>HTML</p>',
    });
  });

  it('builds invite emails on top of the shared sender helper', async () => {
    await sendInviteEmail({
      to: 'new@example.com',
      inviteUrl: 'https://hub.test/invite/token',
      orgName: 'Example Org',
      role: 'Admin',
      smtp,
    });

    expect(nodemailerMocks.sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'new@example.com',
        subject: "You're invited to Example Org on Agent Hub",
        text: expect.stringContaining('https://hub.test/invite/token'),
        html: expect.stringContaining('Accept the invite'),
      }),
    );
  });

  it('redacts configured SMTP credentials from logged errors', () => {
    expect(safeEmailError(new Error('bad auth for mailer@example.com:super-secret'), smtp)).toBe(
      'bad auth for [redacted]:[redacted]',
    );
  });
});
