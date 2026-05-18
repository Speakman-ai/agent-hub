import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// `auto-git.ts` reads `process.env.PATH` (via resolveSpawnPath) and does not
// otherwise depend on `child_process` for `autoGitChildEnv` itself. We still
// stub `child_process` so importing the module doesn't try to spawn anything.
vi.mock('child_process', () => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// `autoGitChildEnv` itself doesn't touch `fs`, but other code-paths in
// `auto-git.ts` (auto-merge resolution etc.) do — silence those at import time.
vi.mock('fs', () => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  statSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { autoGitChildEnv, initAutoGit } from './auto-git.js';

// Snapshot + restore the host-inherited env so cross-test pollution can't
// invalidate the assertions ("the previous test set GH_TOKEN and the scrub
// must run on each call to be observable").
let savedEnv: Record<string, string | undefined>;
const ENV_KEYS_TO_SAVE = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
];

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS_TO_SAVE) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS_TO_SAVE) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
});

describe('autoGitChildEnv — identity isolation', () => {
  it('scrubs inherited GH_TOKEN / GITHUB_TOKEN regardless of whether a token is supplied', () => {
    process.env.GH_TOKEN = 'ghs_host_app_installation_token';
    process.env.GITHUB_TOKEN = 'ghs_host_app_installation_token';
    process.env.GH_ENTERPRISE_TOKEN = 'enterprise-host-token';
    process.env.GITHUB_ENTERPRISE_TOKEN = 'enterprise-host-token';

    const envNoToken = autoGitChildEnv(null);
    expect(envNoToken.GH_TOKEN).toBeUndefined();
    expect(envNoToken.GITHUB_TOKEN).toBeUndefined();
    expect(envNoToken.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(envNoToken.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();

    const envWithToken = autoGitChildEnv('gho_user_oauth_token');
    expect(envWithToken.GH_TOKEN).toBe('gho_user_oauth_token');
    expect(envWithToken.GITHUB_TOKEN).toBe('gho_user_oauth_token');
    // Enterprise vars stay scrubbed — the supplied token is github.com-only.
    expect(envWithToken.GH_ENTERPRISE_TOKEN).toBeUndefined();
    expect(envWithToken.GITHUB_ENTERPRISE_TOKEN).toBeUndefined();
  });

  it('appends the empty credential.https://github.com.helper sentinel even with no token', () => {
    delete process.env.GIT_CONFIG_COUNT;

    const env = autoGitChildEnv(null);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
  });

  it('appends the empty sentinel BEFORE the working helper when a token is supplied', () => {
    delete process.env.GIT_CONFIG_COUNT;

    const env = autoGitChildEnv('gho_test_token');
    expect(env.GIT_CONFIG_COUNT).toBe('2');
    // Empty sentinel at index 0 clears the accumulated helper list.
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_0).toBe('');
    // Working helper at index 1 emits username=x-access-token + password=$GH_TOKEN.
    expect(env.GIT_CONFIG_KEY_1).toBe('credential.https://github.com.helper');
    expect((env.GIT_CONFIG_VALUE_1 ?? '').length).toBeGreaterThan(0);
    expect(env.GIT_CONFIG_VALUE_1).toContain('GH_TOKEN');
  });

  it('preserves any pre-existing GIT_CONFIG_COUNT and appends after it', () => {
    process.env.GIT_CONFIG_COUNT = '3';

    const env = autoGitChildEnv(null);
    expect(env.GIT_CONFIG_COUNT).toBe('4');
    expect(env.GIT_CONFIG_KEY_3).toBe('credential.https://github.com.helper');
    expect(env.GIT_CONFIG_VALUE_3).toBe('');
  });

  it('falls back gracefully when GIT_CONFIG_COUNT is malformed', () => {
    process.env.GIT_CONFIG_COUNT = 'not-a-number';

    const env = autoGitChildEnv(null);
    // Malformed value collapses to 0 — the new entry lands at index 0.
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('credential.https://github.com.helper');
  });

  it('does NOT set GH_CONFIG_DIR when deps are uninitialised (test mode)', () => {
    // No initAutoGit() call before this test — safeResolveDataDir returns
    // null and `autoGitChildEnv` simply omits GH_CONFIG_DIR. The env-scrub +
    // empty-helper alone are still enough to neutralise host gh auth via
    // `git push` (the most common server-side leak path).
    const env = autoGitChildEnv(null);
    expect(env.GH_CONFIG_DIR).toBeUndefined();
  });

  it('points GH_CONFIG_DIR at config.dataDir/reviewer-gh-config when deps are initialised', () => {
    initAutoGit({
      // Minimal viable deps — the only field `autoGitChildEnv` reads is
      // `config.dataDir` via `safeResolveDataDir`.
      stmts: {} as never,
      broadcast: () => {},
      getConfig: () => ({ dataDir: '/tmp/agent-hub-test' }) as never,
      DEFAULT_SKILLS_DIR: '/tmp/skills',
    });

    try {
      const env = autoGitChildEnv(null);
      // The reviewer-gh-config sibling directory is what spawn-side isolation
      // uses; auto-git reuses it so the operator only has one isolation
      // directory to inspect on disk.
      expect(env.GH_CONFIG_DIR).toBe('/tmp/agent-hub-test/reviewer-gh-config');
    } finally {
      // Reset deps so other tests in the suite (run in module-scope order)
      // see the uninitialised default again.
      initAutoGit({
        stmts: {} as never,
        broadcast: () => {},
        getConfig: () => ({}) as never,
        DEFAULT_SKILLS_DIR: '/tmp/skills',
      });
    }
  });

  it('PATH is normalised via resolveSpawnPath (login-shell merge preserved)', () => {
    const env = autoGitChildEnv(null);
    // resolveSpawnPath always returns a non-empty PATH even when the
    // process env has no PATH set; assert the shape rather than an exact
    // value so the test stays portable across CI / dev hosts.
    expect(typeof env.PATH).toBe('string');
    expect((env.PATH ?? '').length).toBeGreaterThan(0);
  });
});
