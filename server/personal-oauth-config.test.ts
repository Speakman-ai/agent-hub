import { describe, it, expect } from 'vitest';
import { resolvePersonalOAuthConfig } from './personal-oauth-config.js';

describe('resolvePersonalOAuthConfig', () => {
  it('returns personalOAuth credentials when complete', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: 'pid', clientSecret: 'psecret' },
      }),
    ).toEqual({ clientId: 'pid', clientSecret: 'psecret' });
  });

  it('falls back to legacy githubApp credentials when personalOAuth is absent', () => {
    // The exact upgrade path the reviewer flagged: an existing GitHub App
    // install whose config.json still has githubApp.clientId/clientSecret but
    // no personalOAuth block. Without the fallback this returns null and
    // /api/auth/github/start 503s + token refresh breaks.
    expect(
      resolvePersonalOAuthConfig({
        githubApp: { clientId: 'app-id', clientSecret: 'app-secret', appId: '123' },
      }),
    ).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });
  });

  it('prefers personalOAuth over the legacy githubApp block when both are present', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: 'new-id', clientSecret: 'new-secret' },
        githubApp: { clientId: 'old-id', clientSecret: 'old-secret' },
      }),
    ).toEqual({ clientId: 'new-id', clientSecret: 'new-secret' });
  });

  it('falls back to githubApp when personalOAuth is partial (id but no secret)', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: 'half' },
        githubApp: { clientId: 'app-id', clientSecret: 'app-secret' },
      }),
    ).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });
  });

  it('returns null when neither source has a complete id+secret pair', () => {
    expect(resolvePersonalOAuthConfig({})).toBeNull();
    expect(resolvePersonalOAuthConfig({ personalOAuth: { clientId: 'only-id' } })).toBeNull();
    expect(resolvePersonalOAuthConfig({ githubApp: { clientId: 'only-id' } })).toBeNull();
    expect(
      resolvePersonalOAuthConfig({ githubApp: { appId: '123', privateKey: 'pk' } }),
    ).toBeNull();
  });

  it('ignores non-string credential values', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: 123 as unknown as string, clientSecret: 'x' },
        githubApp: { clientId: true, clientSecret: 'y' },
      }),
    ).toBeNull();
  });

  it('treats an empty-string personalOAuth block as missing and falls back to githubApp', () => {
    // Regression: a blank modern block must NOT shadow valid legacy
    // credentials. An upgraded config can carry `personalOAuth: { clientId:
    // '', clientSecret: '' }` (e.g. a settings form that wrote empty fields)
    // alongside working `githubApp` creds; returning blanks here would break
    // GitHub OAuth start/refresh instead of using the preserved fallback.
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: '', clientSecret: '' },
        githubApp: { clientId: 'app-id', clientSecret: 'app-secret' },
      }),
    ).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });
  });

  it('treats whitespace-only credentials as missing', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: '   ', clientSecret: '\t\n' },
        githubApp: { clientId: 'app-id', clientSecret: 'app-secret' },
      }),
    ).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });

    // No fallback either → null, not a blank pair.
    expect(
      resolvePersonalOAuthConfig({ personalOAuth: { clientId: ' ', clientSecret: ' ' } }),
    ).toBeNull();
  });

  it('returns null when an empty personalOAuth block has only an empty legacy fallback', () => {
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: '', clientSecret: '' },
        githubApp: { clientId: '', clientSecret: '' },
      }),
    ).toBeNull();
  });

  it('trims surrounding whitespace from accepted credentials', () => {
    // Tolerate a stray newline pasted into config.json.
    expect(
      resolvePersonalOAuthConfig({
        personalOAuth: { clientId: ' pid\n', clientSecret: '\tpsecret ' },
      }),
    ).toEqual({ clientId: 'pid', clientSecret: 'psecret' });
  });
});
