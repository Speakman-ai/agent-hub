import { describe, it, expect } from 'vitest';
import { resolveGithubAppConfig } from './github-app-config.js';

describe('resolveGithubAppConfig', () => {
  it('returns null when there is no githubApp block', () => {
    expect(resolveGithubAppConfig({})).toBeNull();
    expect(resolveGithubAppConfig({ githubApp: null })).toBeNull();
    expect(resolveGithubAppConfig({ githubApp: 'nonsense' })).toBeNull();
  });

  it('returns null for a legacy OAuth-only block (no appId/privateKey)', () => {
    // This block still powers resolvePersonalOAuthConfig, but is NOT a usable
    // App-for-mirroring config — so mirror auth transparently falls back.
    expect(
      resolveGithubAppConfig({ githubApp: { clientId: 'abc', clientSecret: 'def' } }),
    ).toBeNull();
  });

  it('requires BOTH appId and privateKey', () => {
    expect(resolveGithubAppConfig({ githubApp: { appId: '123' } })).toBeNull();
    expect(resolveGithubAppConfig({ githubApp: { privateKey: 'KEY' } })).toBeNull();
    expect(resolveGithubAppConfig({ githubApp: { appId: '', privateKey: 'KEY' } })).toBeNull();
    expect(resolveGithubAppConfig({ githubApp: { appId: '123', privateKey: '   ' } })).toBeNull();
  });

  it('resolves a minimal appId + privateKey (installationId optional)', () => {
    const resolved = resolveGithubAppConfig({
      githubApp: { appId: 123, privateKey: 'KEY' },
    });
    expect(resolved).toEqual({ appId: 123, privateKey: 'KEY' });
    expect(resolved?.installationId).toBeUndefined();
  });

  it('carries installationId, normalizing a numeric-string id and trimming the key', () => {
    const resolved = resolveGithubAppConfig({
      githubApp: { appId: '123', privateKey: '  KEY  ', installationId: '456' },
    });
    expect(resolved).toEqual({ appId: '123', privateKey: 'KEY', installationId: '456' });
  });

  it('maps installations[], dropping entries with no id and normalizing accounts', () => {
    const resolved = resolveGithubAppConfig({
      githubApp: {
        appId: '1',
        privateKey: 'KEY',
        installations: [
          { account: 'Acme', id: 111 },
          { account: '', id: 222 }, // blank account kept, id-only
          { account: 'noid' }, // dropped — no id
          { id: '333' },
        ],
      },
    });
    expect(resolved?.installations).toEqual([
      { account: 'Acme', id: 111 },
      { id: 222 },
      { id: '333' },
    ]);
  });

  it('omits installations entirely when the array yields no valid entries', () => {
    const resolved = resolveGithubAppConfig({
      githubApp: { appId: '1', privateKey: 'KEY', installations: [{ account: 'x' }] },
    });
    expect(resolved).toEqual({ appId: '1', privateKey: 'KEY' });
    expect(resolved && 'installations' in resolved).toBe(false);
  });
});
