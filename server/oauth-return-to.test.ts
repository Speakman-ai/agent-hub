import { describe, it, expect } from 'vitest';
import {
  sanitizeOAuthReturnTo,
  isMobileOAuthReturnTo,
  MOBILE_OAUTH_SCHEMES,
} from './oauth-return-to.js';

describe('sanitizeOAuthReturnTo', () => {
  it('accepts a same-origin relative path', () => {
    expect(sanitizeOAuthReturnTo('/settings?tab=git#frag')).toBe('/settings?tab=git#frag');
    expect(sanitizeOAuthReturnTo('/')).toBe('/');
  });

  it('rejects protocol-relative paths (open-redirect)', () => {
    expect(sanitizeOAuthReturnTo('//evil.com/phish')).toBeUndefined();
  });

  it('rejects absolute http(s) URLs', () => {
    expect(sanitizeOAuthReturnTo('https://evil.com')).toBeUndefined();
    expect(sanitizeOAuthReturnTo('http://evil.com')).toBeUndefined();
  });

  it('rejects dangerous non-allowlisted schemes', () => {
    expect(sanitizeOAuthReturnTo('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeOAuthReturnTo('data:text/html,<script>')).toBeUndefined();
    expect(sanitizeOAuthReturnTo('file:///etc/passwd')).toBeUndefined();
  });

  it('accepts the mobile app deep-link scheme (case-insensitive)', () => {
    expect(sanitizeOAuthReturnTo('agenthub://oauth-callback')).toBe('agenthub://oauth-callback');
    expect(sanitizeOAuthReturnTo('AgentHub://oauth-callback')).toBe('AgentHub://oauth-callback');
    expect(sanitizeOAuthReturnTo('agenthub://oauth/github?ok=1')).toBe(
      'agenthub://oauth/github?ok=1',
    );
  });

  it('rejects a look-alike scheme not on the allowlist', () => {
    expect(sanitizeOAuthReturnTo('agenthubx://oauth')).toBeUndefined();
    expect(sanitizeOAuthReturnTo('notagenthub://oauth')).toBeUndefined();
  });

  it('returns undefined for empty / non-string input', () => {
    expect(sanitizeOAuthReturnTo('')).toBeUndefined();
    expect(sanitizeOAuthReturnTo(undefined)).toBeUndefined();
    expect(sanitizeOAuthReturnTo(null)).toBeUndefined();
    expect(sanitizeOAuthReturnTo(42)).toBeUndefined();
  });
});

describe('isMobileOAuthReturnTo', () => {
  it('is true only for allowlisted custom schemes', () => {
    expect(isMobileOAuthReturnTo('agenthub://oauth-callback')).toBe(true);
    expect(isMobileOAuthReturnTo('/settings')).toBe(false);
    expect(isMobileOAuthReturnTo('https://hub.example.com')).toBe(false);
  });
});

describe('MOBILE_OAUTH_SCHEMES', () => {
  it('declares the app scheme that mobile/app.json must mirror', () => {
    expect(MOBILE_OAUTH_SCHEMES).toContain('agenthub');
  });
});
