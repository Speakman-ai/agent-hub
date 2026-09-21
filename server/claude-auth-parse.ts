import { stripAnsi } from './ansi-strip.js';
import { parseClaudeOAuthExpiry } from './oauth-expiry.js';
import path from 'path';

interface ClaudeCredentialsPayload {
  claudeAiOauth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
}

/**
 * Validate the part of Claude Code's credentials file that proves a usable
 * browser session. File existence alone is not enough: interrupted logins
 * can leave an empty/malformed file, and an expired OAuth cache must not make
 * the mobile UI hide its sign-in action.
 */
export function isClaudeLoginCacheValid(raw: string): boolean {
  try {
    const payload = JSON.parse(raw) as ClaudeCredentialsPayload;
    const oauth = payload?.claudeAiOauth;
    if (!oauth || typeof oauth !== 'object') return false;

    const hasToken = [oauth.accessToken, oauth.refreshToken].some(
      (token) => typeof token === 'string' && token.trim().length > 0,
    );
    const expiryValue =
      typeof oauth.expiresAt === 'string' || typeof oauth.expiresAt === 'number'
        ? oauth.expiresAt
        : null;
    const expiry = parseClaudeOAuthExpiry(expiryValue);
    return hasToken && expiry !== null && !expiry.expired;
  } catch {
    return false;
  }
}

/** Claude Code's browser login writes this file below the per-user HOME. */
export function hasClaudeLoginCache(home: string, readFile: (path: string) => string): boolean {
  try {
    return isClaudeLoginCacheValid(readFile(path.join(home, '.claude', '.credentials.json')));
  } catch {
    return false;
  }
}

/**
 * Extract only Anthropic/Claude authorization URLs from `claude auth login` output.
 * The allowlist prevents an incidental documentation link from being exposed
 * as a credential-login action.
 */
export function extractClaudeLoginUrl(text: string): string | null {
  const plain = stripAnsi(text);
  // OSC 8 hyperlinks end the target with a control character (BEL or ESC).
  // Keep the target, but never include the terminator or link label in the URL.
  const match = plain.match(
    /https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com|auth\.anthropic\.com)\/[^\s\p{Cc})\]]+/iu,
  );
  return match?.[0] ?? null;
}

export function computeClaudeUiStatus(input: {
  binaryPresent: boolean;
  loginInProgress: boolean;
  authenticated: boolean;
}): 'missing' | 'pending' | 'authenticated' {
  if (!input.binaryPresent) return 'missing';
  if (input.loginInProgress) return 'pending';
  return input.authenticated ? 'authenticated' : 'missing';
}
