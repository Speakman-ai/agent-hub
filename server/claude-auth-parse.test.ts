import { describe, expect, it } from 'vitest';
import {
  computeClaudeUiStatus,
  extractClaudeLoginUrl,
  isClaudeLoginCacheValid,
} from './claude-auth-parse.js';

describe('Claude browser auth parsing', () => {
  it('extracts the Anthropic login URL and strips terminal color codes', () => {
    expect(
      extractClaudeLoginUrl(
        '\u001b[36mOpen this link to sign in: https://claude.ai/oauth/authorize?state=abc\u001b[0m',
      ),
    ).toBe('https://claude.ai/oauth/authorize?state=abc');
  });

  it('ignores unrelated URLs in CLI output', () => {
    expect(extractClaudeLoginUrl('See https://docs.anthropic.com/help first')).toBeNull();
  });

  it.each([
    ['', 'empty'],
    ['not json', 'malformed'],
    ['{"claudeAiOauth":{}}', 'missing token and expiry'],
    [
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'expired-access',
          expiresAt: Date.now() - 60_000,
        },
      }),
      'expired',
    ],
  ])('rejects %s Claude credential cache', (raw) => {
    expect(isClaudeLoginCacheValid(raw)).toBe(false);
  });

  it('accepts a credential cache with a token and future expiry', () => {
    expect(
      isClaudeLoginCacheValid(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAt: Date.now() + 60_000,
          },
        }),
      ),
    ).toBe(true);
  });

  it('gates authenticated status on an installed binary', () => {
    expect(
      computeClaudeUiStatus({ binaryPresent: false, loginInProgress: false, authenticated: true }),
    ).toBe('missing');
    expect(
      computeClaudeUiStatus({ binaryPresent: true, loginInProgress: true, authenticated: false }),
    ).toBe('pending');
    expect(
      computeClaudeUiStatus({ binaryPresent: true, loginInProgress: false, authenticated: true }),
    ).toBe('authenticated');
  });
});
