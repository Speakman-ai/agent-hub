import { describe, it, expect } from 'vitest';
import {
  resolveOAuthAppCredentials,
  applyGithubSpawnCredentials,
} from './spawn-github-credentials.js';
import type { AppConfig } from './types.js';

type CredsConfig = Pick<AppConfig, 'personalOAuth' | 'githubApp'>;

function makeConfig(over: Partial<CredsConfig> = {}): CredsConfig {
  return {
    personalOAuth: null,
    githubApp: null,
    ...over,
  };
}

describe('resolveOAuthAppCredentials', () => {
  it('returns null when neither personalOAuth nor githubApp has both fields', () => {
    expect(resolveOAuthAppCredentials(makeConfig())).toBeNull();
  });

  it('prefers personalOAuth over githubApp when both are configured', () => {
    const creds = resolveOAuthAppCredentials(
      makeConfig({
        personalOAuth: { clientId: 'personal-id', clientSecret: 'personal-secret' },
        // Cast: GitHubAppConfig has many other required fields that aren't
        // exercised here; resolveOAuthAppCredentials only inspects clientId
        // and clientSecret, so the partial shape is enough.
        githubApp: {
          clientId: 'app-id',
          clientSecret: 'app-secret',
        } as unknown as AppConfig['githubApp'],
      }),
    );
    expect(creds).toEqual({ clientId: 'personal-id', clientSecret: 'personal-secret' });
  });

  it('falls back to githubApp when personalOAuth is missing', () => {
    const creds = resolveOAuthAppCredentials(
      makeConfig({
        githubApp: {
          clientId: 'app-id',
          clientSecret: 'app-secret',
        } as unknown as AppConfig['githubApp'],
      }),
    );
    expect(creds).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });
  });

  it('treats partial personalOAuth (missing clientSecret) as not configured', () => {
    const creds = resolveOAuthAppCredentials(
      makeConfig({
        personalOAuth: { clientId: 'personal-id', clientSecret: '' },
        githubApp: {
          clientId: 'app-id',
          clientSecret: 'app-secret',
        } as unknown as AppConfig['githubApp'],
      }),
    );
    // Empty string is falsy → falls through to githubApp.
    expect(creds).toEqual({ clientId: 'app-id', clientSecret: 'app-secret' });
  });

  it('treats partial githubApp (missing clientId) as not configured', () => {
    const creds = resolveOAuthAppCredentials(
      makeConfig({
        githubApp: {
          clientId: '',
          clientSecret: 'app-secret',
        } as unknown as AppConfig['githubApp'],
      }),
    );
    expect(creds).toBeNull();
  });
});

describe('applyGithubSpawnCredentials', () => {
  it('is a no-op when token is null', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    applyGithubSpawnCredentials(env, null);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('is a no-op when token is empty string', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, '');
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('is a no-op when token is undefined', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, undefined);
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
  });

  it('sets GH_TOKEN and GITHUB_TOKEN to the supplied token', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'ghu_test_token_123');
    expect(env.GH_TOKEN).toBe('ghu_test_token_123');
    expect(env.GITHUB_TOKEN).toBe('ghu_test_token_123');
  });

  it('installs a credential helper scoped to https://github.com', () => {
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'ghu_test_token_123');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    // Helper snippet must dereference $GH_TOKEN at runtime, not bake the
    // literal token into the gitconfig value.
    expect(env.GIT_CONFIG_VALUE_0).toContain('$GH_TOKEN');
    expect(env.GIT_CONFIG_VALUE_0).toContain('username=x-access-token');
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('ghu_test_token_123');
  });

  it('helper snippet emits no output when GH_TOKEN is unset (degrades gracefully)', () => {
    // We can't execute the snippet in-process safely, but we can assert
    // it guards on $GH_TOKEN before printing. Combined with the unset
    // case below, this is enough to know the helper won't emit empty
    // creds when the wrapping process forgot to set GH_TOKEN.
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, 'tok');
    const snippet = String(env.GIT_CONFIG_VALUE_0);
    expect(snippet).toMatch(/test -n "\$GH_TOKEN"/);
  });

  it('appends to a pre-existing GIT_CONFIG_COUNT instead of clobbering', () => {
    const env: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Existing User',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'pre@existing.example',
    };
    applyGithubSpawnCredentials(env, 'ghu_token');

    expect(env.GIT_CONFIG_COUNT).toBe('3');
    // Pre-existing entries must be untouched.
    expect(env.GIT_CONFIG_KEY_0).toBe('user.name');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Existing User');
    expect(env.GIT_CONFIG_KEY_1).toBe('user.email');
    expect(env.GIT_CONFIG_VALUE_1).toBe('pre@existing.example');
    // Our helper lands at the next free slot.
    expect(env.GIT_CONFIG_KEY_2).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_2).toContain('$GH_TOKEN');
  });

  it('treats a malformed pre-existing GIT_CONFIG_COUNT as 0', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: 'not-a-number' };
    applyGithubSpawnCredentials(env, 'ghu_token');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('treats a negative pre-existing GIT_CONFIG_COUNT as 0', () => {
    const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: '-3' };
    applyGithubSpawnCredentials(env, 'ghu_token');
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('does not leak the token literal into the helper string (rotation safety)', () => {
    const token = 'ghu_super_secret_value_12345';
    const env: NodeJS.ProcessEnv = {};
    applyGithubSpawnCredentials(env, token);
    expect(env.GIT_CONFIG_VALUE_0).not.toContain(token);
    // But GH_TOKEN itself must carry the literal — that's the runtime
    // value the helper reads.
    expect(env.GH_TOKEN).toBe(token);
  });
});
