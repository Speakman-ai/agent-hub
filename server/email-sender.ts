import nodemailer from 'nodemailer';
import config from './config.js';
import type { SmtpConfig } from './types.js';
import { isSmtpConfigured, normalizeSmtpConfig, smtpTransportOptions } from './smtp-config.js';

export class EmailNotConfiguredError extends Error {
  code = 'smtp_not_configured';

  constructor() {
    super('SMTP email is not configured');
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  smtp?: SmtpConfig;
}

export interface InviteEmailInput {
  to: string;
  inviteUrl: string;
  orgName: string;
  role: string;
  expiresAt?: string;
  smtp?: SmtpConfig;
}

export interface PasswordResetDeliveryStatus {
  smtpConfigured: boolean;
  fallbackAvailable: boolean;
  fallback: 'owner_generated_reset_code' | null;
}

export function getPasswordResetDeliveryStatus(smtp?: SmtpConfig | null) {
  const normalizedSmtp = normalizeSmtpConfig(smtp ?? config.smtp);
  const smtpConfigured = isSmtpConfigured(normalizedSmtp);
  return {
    smtpConfigured,
    fallbackAvailable: !smtpConfigured,
    fallback: smtpConfigured ? null : 'owner_generated_reset_code',
  } satisfies PasswordResetDeliveryStatus;
}

export function isSmtpDeliveryConfigured(smtp?: SmtpConfig | null): boolean {
  return isSmtpConfigured(normalizeSmtpConfig(smtp ?? config.smtp));
}

export async function sendEmail(input: SendEmailInput) {
  const smtp = normalizeSmtpConfig(input.smtp ?? config.smtp);
  if (!isSmtpConfigured(smtp)) {
    throw new EmailNotConfiguredError();
  }

  const transport = nodemailer.createTransport(smtpTransportOptions(smtp));
  return transport.sendMail({
    from: smtp.from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    html: input.html,
  });
}

export async function sendInviteEmail(input: InviteEmailInput) {
  const subject = `You're invited to ${input.orgName} on Agent Hub`;
  const expiresLabel = input.expiresAt ? formatEmailDate(input.expiresAt) : 'automatically';
  const text = [
    `You've been invited to join ${input.orgName} on Agent Hub as ${input.role}.`,
    '',
    `Accept the invite: ${input.inviteUrl}`,
    '',
    `This invite expires ${expiresLabel} and can only be used once.`,
    '',
    'If the button does not work, copy and paste the invite URL into your browser.',
  ].join('\n');
  const html = [
    `<p>You've been invited to join <strong>${escapeHtml(input.orgName)}</strong> on Agent Hub as <strong>${escapeHtml(input.role)}</strong>.</p>`,
    `<p><a href="${escapeHtml(input.inviteUrl)}">Accept the invite</a></p>`,
    `<p>This invite expires ${escapeHtml(expiresLabel)} and can only be used once.</p>`,
    '<p>If the button does not work, copy and paste the invite URL into your browser.</p>',
  ].join('\n');

  return sendEmail({ to: input.to, subject, text, html, smtp: input.smtp });
}

export function safeEmailError(err: unknown, smtp?: SmtpConfig): string {
  const raw = err instanceof Error ? err.message : String(err);
  let safe = raw.replace(/\s+/g, ' ').trim();
  for (const secret of [smtp?.password, smtp?.username]) {
    if (secret) {
      safe = safe.split(secret).join('[redacted]');
    }
  }
  return safe || 'SMTP send failed';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEmailDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString();
}

// ─── Non-throwing send + password-reset helpers ─────────────────────────────
// The invite path uses the throwing `sendEmail` (it inspects errors via
// `safeEmailError`). Password reset and the release-notification outbox instead
// want a non-throwing result they can branch on, so they go through
// `sendEmailResult`, which maps the throwing API to a `{ sent, reason }` shape.

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailSendResult {
  sent: boolean;
  reason?: 'smtp_not_configured' | 'send_failed';
}

export async function sendEmailResult(message: EmailMessage): Promise<EmailSendResult> {
  try {
    await sendEmail(message);
    return { sent: true };
  } catch (err) {
    if (err instanceof EmailNotConfiguredError) {
      return { sent: false, reason: 'smtp_not_configured' };
    }
    console.warn(`[email] send failed: ${(err as Error).message}`);
    return { sent: false, reason: 'send_failed' };
  }
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}): Promise<EmailSendResult> {
  return sendEmailResult({
    to: opts.to,
    subject: 'Reset your Agent Hub password',
    text: [
      'Use this link to reset your Agent Hub password:',
      '',
      opts.resetUrl,
      '',
      'This link expires in 30 minutes. If you did not request it, ignore this email.',
    ].join('\n'),
    html: [
      '<p>Use this link to reset your Agent Hub password:</p>',
      `<p><a href="${escapeHtml(opts.resetUrl)}">Reset password</a></p>`,
      '<p>This link expires in 30 minutes. If you did not request it, ignore this email.</p>',
    ].join(''),
  });
}

export function buildPasswordResetPath(token: string): string {
  return `/reset?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrl(token: string): string | null {
  const rawBase = process.env.PUBLIC_ORIGIN || config.publicUrl || '';
  const base = canonicalHttpOrigin(rawBase);
  if (!base) return null;
  return `${base.replace(/\/$/, '')}${buildPasswordResetPath(token)}`;
}

export function buildOwnerPasswordResetUrl(token: string): string {
  return buildPasswordResetUrl(token) ?? buildPasswordResetPath(token);
}

function canonicalHttpOrigin(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return trimmed;
  } catch {
    return null;
  }
}
