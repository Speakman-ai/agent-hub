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
    'https://claude.com/cai/oauth/authorize',
    'https://platform.claude.com/oauth/authorize',
    'https://claude.ai/oauth/authorize',
    'https://console.anthropic.com/oauth/authorize',
    'https://auth.anthropic.com/oauth/authorize',
  ])('extracts the complete authorization URL from %s', (base) => {
    const url = `${base}?code_challenge=challenge&state=state&redirect_uri=https%3A%2F%2Fexample.com`;
    expect(extractClaudeLoginUrl(`If the browser didn't open, visit: ${url}\n`)).toBe(url);
  });

  it.each(['\u0007', '\u001b\\'])('extracts OSC 8 hyperlinks terminated by %j', (end) => {
    const url = 'https://claude.com/cai/oauth/authorize?state=complete-state';
    expect(extractClaudeLoginUrl(`\u001b]8;;${url}${end}Open sign-in\u001b]8;;${end}\n`)).toBe(url);
  });

  it.each([
    'https://claude.com.example.com/cai/oauth/authorize?state=abc',
    'https://platform.claude.com@example.com/oauth/authorize?state=abc',
    'https://example.com/oauth/authorize?state=abc',
  ])('rejects untrusted sign-in destinations: %s', (url) => {
    expect(extractClaudeLoginUrl(url)).toBeNull();
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
