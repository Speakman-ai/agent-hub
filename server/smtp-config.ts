import type { SmtpConfig } from './types.js';
import { isEmailIdentifier } from './auth-validation.js';

export const SMTP_SECRET_MASK = '••••••••';
export const SMTP_TLS_MODES = ['none', 'starttls', 'ssl'] as const;

export type SmtpTlsMode = (typeof SMTP_TLS_MODES)[number];

export type MaskedSmtpConfig = Omit<SmtpConfig, 'password'> & {
  password: string | null;
  passwordSet: boolean;
  configured: boolean;
};

export interface SmtpPatchResult {
  ok: boolean;
  config?: SmtpConfig;
  error?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim();
}

function cleanNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parsePort(value: unknown, fallback: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value.trim())
        : fallback;
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
}

function normalizeTlsMode(raw: unknown, secure: unknown, requireTls: unknown): SmtpTlsMode {
  if (typeof raw === 'string') {
    const lowered = raw.trim().toLowerCase();
    if ((SMTP_TLS_MODES as readonly string[]).includes(lowered)) return lowered as SmtpTlsMode;
  }
  if (secure === true) return 'ssl';
  if (requireTls === true) return 'starttls';
  return 'none';
}

export function normalizeSmtpConfig(raw: unknown): SmtpConfig {
  const source = isObject(raw) ? raw : {};
  const tlsMode = normalizeTlsMode(source.tlsMode, source.secure, source.requireTls);
  return {
    enabled: source.enabled === true,
    host: cleanString(source.host) ?? '',
    port: parsePort(source.port, tlsMode === 'ssl' ? 465 : 587),
    tlsMode,
    username: cleanNullableString(source.username) ?? null,
    password: cleanNullableString(source.password) ?? null,
    from: cleanString(source.from) ?? '',
  };
}

export function isSmtpConfigured(
  config: Pick<SmtpConfig, 'enabled' | 'host' | 'port' | 'from'> | null | undefined,
) {
  const normalized = normalizeSmtpConfig(config);
  const from = normalized.from.trim();
  return Boolean(
    normalized.enabled && normalized.host.trim() && normalized.port && isEmailIdentifier(from),
  );
}

export function maskSmtpConfig(config: SmtpConfig | null | undefined): MaskedSmtpConfig {
  const normalized = normalizeSmtpConfig(config);
  return {
    ...normalized,
    password: normalized.password ? SMTP_SECRET_MASK : null,
    passwordSet: Boolean(normalized.password),
    configured: isSmtpConfigured(normalized),
  };
}

export function applySmtpPatch(current: SmtpConfig, raw: unknown): SmtpPatchResult {
  if (!isObject(raw)) return { ok: false, error: 'SMTP settings body must be an object' };

  const next: SmtpConfig = { ...current };
  let touched = false;

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') return { ok: false, error: 'enabled must be boolean' };
    next.enabled = raw.enabled;
    touched = true;
  }

  if ('host' in raw) {
    const value = cleanNullableString(raw.host);
    if (value === undefined) return { ok: false, error: 'host must be a string' };
    next.host = value ?? '';
    touched = true;
  }

  if ('port' in raw) {
    const n =
      typeof raw.port === 'number'
        ? raw.port
        : typeof raw.port === 'string' && raw.port.trim()
          ? Number(raw.port.trim())
          : NaN;
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, error: 'port must be an integer between 1 and 65535' };
    }
    next.port = n;
    touched = true;
  }

  if ('tlsMode' in raw) {
    if (typeof raw.tlsMode !== 'string') return { ok: false, error: 'tlsMode must be a string' };
    const lowered = raw.tlsMode.trim().toLowerCase();
    if (!(SMTP_TLS_MODES as readonly string[]).includes(lowered)) {
      return { ok: false, error: 'tlsMode must be one of none, starttls, or ssl' };
    }
    next.tlsMode = lowered as SmtpTlsMode;
    touched = true;
  }

  if ('username' in raw) {
    const value = cleanNullableString(raw.username);
    if (value === undefined) return { ok: false, error: 'username must be a string or null' };
    next.username = value;
    touched = true;
  }

  if ('password' in raw) {
    if (raw.password === null) {
      next.password = null;
    } else if (typeof raw.password === 'string') {
      if (raw.password === SMTP_SECRET_MASK) {
        // Preserve existing secret.
      } else if (raw.password.trim().length === 0) {
        next.password = null;
      } else {
        next.password = raw.password;
      }
    } else {
      return { ok: false, error: 'password must be a string or null' };
    }
    touched = true;
  }

  if ('from' in raw) {
    const value = cleanNullableString(raw.from);
    if (value === undefined) return { ok: false, error: 'from must be a string' };
    next.from = value ?? '';
    touched = true;
  }

  if (!touched) return { ok: false, error: 'No valid SMTP settings fields provided' };

  if (next.enabled) {
    if (!next.host) return { ok: false, error: 'host is required when SMTP is enabled' };
    if (!next.from) return { ok: false, error: 'from is required when SMTP is enabled' };
  }
  if (next.from && !isEmailIdentifier(next.from)) {
    return { ok: false, error: 'from must be a valid email address' };
  }

  return { ok: true, config: next };
}

export function smtpTransportOptions(config: SmtpConfig) {
  return {
    host: config.host,
    port: config.port,
    secure: config.tlsMode === 'ssl',
    requireTLS: config.tlsMode === 'starttls',
    auth: config.username ? { user: config.username, pass: config.password ?? '' } : undefined,
  };
}
