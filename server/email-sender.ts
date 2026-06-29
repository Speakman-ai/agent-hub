import nodemailer from 'nodemailer';
import config, { fileConfig } from './config.js';

type SmtpTlsMode = 'none' | 'starttls' | 'ssl';

interface SmtpConfig {
  enabled?: boolean;
  host?: string;
  port?: number | string;
  tlsMode?: SmtpTlsMode;
  username?: string;
  password?: string;
  from?: string;
}

export interface EmailSendResult {
  sent: boolean;
  reason?: 'smtp_not_configured' | 'send_failed';
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

function smtpConfig():
  | (Required<Pick<SmtpConfig, 'host' | 'from'>> &
      SmtpConfig & { port: number; tlsMode: SmtpTlsMode })
  | null {
  const raw = fileConfig.smtp as SmtpConfig | undefined;
  if (!raw?.enabled) return null;
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const from = typeof raw.from === 'string' ? raw.from.trim() : '';
  const port =
    typeof raw.port === 'number'
      ? raw.port
      : typeof raw.port === 'string'
        ? Number.parseInt(raw.port, 10)
        : NaN;
  const tlsMode: SmtpTlsMode =
    raw.tlsMode === 'none' || raw.tlsMode === 'starttls' || raw.tlsMode === 'ssl'
      ? raw.tlsMode
      : 'starttls';
  if (!host || !from || !Number.isFinite(port) || port <= 0) return null;
  return { ...raw, host, from, port, tlsMode };
}

export async function sendPasswordResetEmail(opts: {
  to: string;
  resetUrl: string;
}): Promise<EmailSendResult> {
  return sendEmail({
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

export async function sendEmail(message: EmailMessage): Promise<EmailSendResult> {
  const smtp = smtpConfig();
  if (!smtp) return { sent: false, reason: 'smtp_not_configured' };

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.tlsMode === 'ssl',
    requireTLS: smtp.tlsMode === 'starttls',
    auth:
      smtp.username && smtp.password
        ? {
            user: smtp.username,
            pass: smtp.password,
          }
        : undefined,
  });

  try {
    await transporter.sendMail({
      from: smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { sent: true };
  } catch (err) {
    console.warn(`[email] send failed: ${(err as Error).message}`);
    return { sent: false, reason: 'send_failed' };
  }
}

export function buildPasswordResetPath(token: string): string {
  return `/reset?token=${encodeURIComponent(token)}`;
}

export function buildPasswordResetUrl(token: string): string | null {
  const rawBase = process.env.PUBLIC_ORIGIN || config.publicUrl || '';
  const base = canonicalHttpOrigin(rawBase);
  if (!base) return null;
  const path = buildPasswordResetPath(token);
  return `${base.replace(/\/$/, '')}${path}`;
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
