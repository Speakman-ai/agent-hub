/**
 * Regression tests for `mergeAllowlistedExtraEnv` (production implementation
 * in `extra-env-allowlist.ts`, called from `chat.ts` when building `spawnEnv`).
 *
 * Security invariants:
 *   1. Only keys on EXTRA_ENV_ALLOWLIST flow through — non-allowlisted keys
 *      are silently dropped even when absent from spawnEnv.
 *   2. A key already present in spawnEnv is never overwritten — server-resolved
 *      credentials (GH_TOKEN, ANTHROPIC_API_KEY, etc.) always win.
 */

import { describe, it, expect } from 'vitest';
import { mergeAllowlistedExtraEnv } from './extra-env-allowlist.js';

function withMergedEnv(
  spawnEnv: Record<string, string>,
  extraEnv: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env = { ...spawnEnv } as NodeJS.ProcessEnv;
  mergeAllowlistedExtraEnv(env, extraEnv);
  return env;
}

describe('mergeAllowlistedExtraEnv — production extraEnv gate', () => {
  it('allowlisted DEV_HUB_API_KEY is injected when absent from spawnEnv (the normal cross-hub use-case)', () => {
    const result = withMergedEnv(
      { ANTHROPIC_API_KEY: 'real-key' },
      { DEV_HUB_API_KEY: 'ahub_legit' },
    );
    expect(result.DEV_HUB_API_KEY).toBe('ahub_legit');
    expect(result.ANTHROPIC_API_KEY).toBe('real-key');
  });

  it('non-allowlisted key only in extraEnv is DROPPED even though absent from spawnEnv', () => {
    const result = withMergedEnv(
      {},
      { ANTHROPIC_API_KEY: 'attacker-key', DEV_HUB_API_KEY: 'ahub_legit' },
    );
    expect('ANTHROPIC_API_KEY' in result).toBe(false);
    expect(result.DEV_HUB_API_KEY).toBe('ahub_legit');
  });

  it('allowlisted DEV_HUB_API_KEY already in spawnEnv is NOT overwritten', () => {
    const result = withMergedEnv(
      { DEV_HUB_API_KEY: 'server-resolved-key' },
      { DEV_HUB_API_KEY: 'caller-key' },
    );
    expect(result.DEV_HUB_API_KEY).toBe('server-resolved-key');
  });

  it('client-supplied GH_TOKEN is dropped (not on allowlist)', () => {
    const result = withMergedEnv(
      { ANTHROPIC_API_KEY: 'real-key' },
      { GH_TOKEN: 'attacker-token', DEV_HUB_API_KEY: 'ahub_legit' },
    );
    expect('GH_TOKEN' in result).toBe(false);
    expect(result.DEV_HUB_API_KEY).toBe('ahub_legit');
  });

  it('client-supplied CLAUDE_CODE_OAUTH_TOKEN is dropped (not on allowlist)', () => {
    const result = withMergedEnv({}, { CLAUDE_CODE_OAUTH_TOKEN: 'attacker-oauth-token' });
    expect('CLAUDE_CODE_OAUTH_TOKEN' in result).toBe(false);
  });

  it('empty extraEnv leaves spawnEnv unchanged', () => {
    const spawnEnv = { GH_TOKEN: 'token', ANTHROPIC_API_KEY: 'key' };
    const result = withMergedEnv(spawnEnv, {});
    expect(result).toEqual(spawnEnv);
  });

  it('undefined extraEnv leaves spawnEnv unchanged', () => {
    const spawnEnv = { GH_TOKEN: 'token' };
    const result = withMergedEnv(spawnEnv, undefined);
    expect(result).toEqual(spawnEnv);
  });

  it('multi-key attack: all non-allowlisted override attempts are dropped, DEV_HUB_API_KEY flows through', () => {
    const result = withMergedEnv(
      {
        GH_TOKEN: 'server-gh',
        ANTHROPIC_API_KEY: 'server-anthropic',
        CLAUDE_CODE_OAUTH_TOKEN: 'server-oauth',
        AGENT_HUB_URL: 'http://localhost:3051',
        AGENT_HUB_API_KEY: 'server-hub-key',
      },
      {
        GH_TOKEN: 'evil-gh',
        ANTHROPIC_API_KEY: 'evil-anthropic',
        CLAUDE_CODE_OAUTH_TOKEN: 'evil-oauth',
        AGENT_HUB_URL: 'http://attacker.example.com',
        AGENT_HUB_API_KEY: 'evil-hub-key',
        DEV_HUB_API_KEY: 'ahub_legit',
      },
    );
    expect(result.GH_TOKEN).toBe('server-gh');
    expect(result.ANTHROPIC_API_KEY).toBe('server-anthropic');
    expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBe('server-oauth');
    expect(result.AGENT_HUB_URL).toBe('http://localhost:3051');
    expect(result.AGENT_HUB_API_KEY).toBe('server-hub-key');
    expect(result.DEV_HUB_API_KEY).toBe('ahub_legit');
  });
});
