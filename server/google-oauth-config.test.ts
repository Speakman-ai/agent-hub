import { describe, it, expect } from 'vitest';
import { resolveGoogleOAuthConfig } from './google-oauth-config.js';

describe('resolveGoogleOAuthConfig', () => {
  it('returns null when no googleOAuth block is present', () => {
    expect(resolveGoogleOAuthConfig({})).toBeNull();
  });

  it('returns null when the block is null', () => {
    expect(resolveGoogleOAuthConfig({ googleOAuth: null })).toBeNull();
  });

  it('resolves a complete client id/secret pair', () => {
    expect(
      resolveGoogleOAuthConfig({
        googleOAuth: { clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' },
      }),
    ).toEqual({ clientId: 'abc.apps.googleusercontent.com', clientSecret: 'shh' });
  });

  it('trims surrounding whitespace from both fields', () => {
    expect(
      resolveGoogleOAuthConfig({
        googleOAuth: { clientId: '  abc  ', clientSecret: '\nshh\n' },
      }),
    ).toEqual({ clientId: 'abc', clientSecret: 'shh' });
  });

  it('treats a partial block (only clientId) as unconfigured', () => {
    expect(resolveGoogleOAuthConfig({ googleOAuth: { clientId: 'abc' } })).toBeNull();
  });

  it('treats a partial block (only clientSecret) as unconfigured', () => {
    expect(resolveGoogleOAuthConfig({ googleOAuth: { clientSecret: 'shh' } })).toBeNull();
  });

  it('treats a blank block as unconfigured', () => {
    expect(
      resolveGoogleOAuthConfig({ googleOAuth: { clientId: '   ', clientSecret: '' } }),
    ).toBeNull();
  });

  it('ignores non-string credential values', () => {
    expect(
      resolveGoogleOAuthConfig({
        googleOAuth: { clientId: 123 as unknown as string, clientSecret: 'shh' },
      }),
    ).toBeNull();
  });
});
