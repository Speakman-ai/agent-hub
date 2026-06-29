import { describe, expect, it } from 'vitest';
import {
  SMTP_SECRET_MASK,
  applySmtpPatch,
  isSmtpConfigured,
  maskSmtpConfig,
  normalizeSmtpConfig,
  smtpTransportOptions,
} from './smtp-config.js';
import type { SmtpConfig } from './types.js';

const baseConfig: SmtpConfig = {
  enabled: true,
  host: 'smtp.example.com',
  port: 587,
  tlsMode: 'starttls',
  username: 'mailer',
  password: 'stored-secret',
  from: 'agenthub@example.com',
};

describe('smtp config helpers', () => {
  it('normalizes legacy TLS fields and masks stored passwords', () => {
    const normalized = normalizeSmtpConfig({
      enabled: true,
      host: ' smtp.example.com ',
      secure: true,
      username: ' mailer ',
      password: ' secret ',
      from: ' agenthub@example.com ',
    });

    expect(normalized).toMatchObject({
      enabled: true,
      host: 'smtp.example.com',
      port: 465,
      tlsMode: 'ssl',
      username: 'mailer',
      password: 'secret',
      from: 'agenthub@example.com',
    });
    expect(maskSmtpConfig(normalized)).toMatchObject({
      password: SMTP_SECRET_MASK,
      passwordSet: true,
      configured: true,
    });
    expect(maskSmtpConfig({ ...normalized, from: 'not-an-email' }).configured).toBe(false);
  });

  it('treats missing SMTP config as not configured', () => {
    expect(isSmtpConfigured(undefined)).toBe(false);
    expect(maskSmtpConfig(undefined)).toMatchObject({
      enabled: false,
      passwordSet: false,
      configured: false,
    });
  });

  it('preserves, replaces, and clears the SMTP password through partial patches', () => {
    expect(applySmtpPatch(baseConfig, { host: 'smtp2.example.com' }).config?.password).toBe(
      'stored-secret',
    );
    expect(applySmtpPatch(baseConfig, { password: SMTP_SECRET_MASK }).config?.password).toBe(
      'stored-secret',
    );
    expect(applySmtpPatch(baseConfig, { password: 'new-secret' }).config?.password).toBe(
      'new-secret',
    );
    expect(applySmtpPatch(baseConfig, { password: null }).config?.password).toBeNull();
    expect(applySmtpPatch(baseConfig, { password: '   ' }).config?.password).toBeNull();
  });

  it('validates enabled config and maps TLS mode to Nodemailer options', () => {
    expect(applySmtpPatch({ ...baseConfig, host: '' }, { enabled: true })).toMatchObject({
      ok: false,
      error: 'host is required when SMTP is enabled',
    });
    expect(applySmtpPatch(baseConfig, { from: 'not-an-email' })).toMatchObject({
      ok: false,
      error: 'from must be a valid email address',
    });

    expect(smtpTransportOptions(baseConfig)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      auth: { user: 'mailer', pass: 'stored-secret' },
    });
    expect(smtpTransportOptions({ ...baseConfig, tlsMode: 'ssl' })).toMatchObject({
      secure: true,
      requireTLS: false,
    });
  });
});
