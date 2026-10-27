import type { GoogleAccountSelector } from './google-connections-store.js';

/**
 * Turn a raw `account` value (query param, wrapper flag, ReAct field) into a
 * store selector. Values containing `@` are emails, anything else is an account
 * id. Empty or missing → undefined, which means the default account.
 */
export function parseGoogleAccountSelector(raw: unknown): GoogleAccountSelector | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.includes('@') ? { email: trimmed } : { accountId: trimmed };
}
