import { describe, it, expect } from 'vitest';
import { resolveGitHubToken, hasGitHubToken } from './github-skill-auth-resolve.js';

describe('resolveGitHubToken', () => {
  it('returns GH_TOKEN when set, with correct source', () => {
    const result = resolveGitHubToken({ GH_TOKEN: 'ghp_agent123' });
    expect(result.token).toBe('ghp_agent123');
    expect(result.source).toBe('GH_TOKEN');
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN is absent', () => {
    const result = resolveGitHubToken({ GITHUB_TOKEN: 'ghp_actions456' });
    expect(result.token).toBe('ghp_actions456');
    expect(result.source).toBe('GITHUB_TOKEN');
  });

  it('prefers GH_TOKEN over GITHUB_TOKEN when both are set', () => {
    const result = resolveGitHubToken({
      GH_TOKEN: 'ghp_agent123',
      GITHUB_TOKEN: 'ghp_actions456',
    });
    expect(result.token).toBe('ghp_agent123');
    expect(result.source).toBe('GH_TOKEN');
  });

  it('returns undefined token when neither var is set', () => {
    const result = resolveGitHubToken({});
    expect(result.token).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it('returns undefined when GH_TOKEN is an empty string', () => {
    const result = resolveGitHubToken({ GH_TOKEN: '' });
    expect(result.token).toBeUndefined();
  });

  it('returns undefined when GH_TOKEN is whitespace only', () => {
    const result = resolveGitHubToken({ GH_TOKEN: '   ' });
    expect(result.token).toBeUndefined();
  });

  it('returns undefined when GITHUB_TOKEN is an empty string', () => {
    const result = resolveGitHubToken({ GH_TOKEN: '', GITHUB_TOKEN: '' });
    expect(result.token).toBeUndefined();
  });

  it('trims surrounding whitespace from GH_TOKEN', () => {
    const result = resolveGitHubToken({ GH_TOKEN: '  ghp_trimmed  ' });
    expect(result.token).toBe('ghp_trimmed');
    expect(result.source).toBe('GH_TOKEN');
  });

  it('trims surrounding whitespace from GITHUB_TOKEN', () => {
    const result = resolveGitHubToken({ GITHUB_TOKEN: '  ghp_trimmed  ' });
    expect(result.token).toBe('ghp_trimmed');
    expect(result.source).toBe('GITHUB_TOKEN');
  });

  it('ignores unrelated environment variables', () => {
    const result = resolveGitHubToken({ UNRELATED_API_KEY: 'unrelated_abc', NODE_ENV: 'test' });
    expect(result.token).toBeUndefined();
    expect(result.source).toBeUndefined();
  });

  it('never throws when env is empty', () => {
    expect(() => resolveGitHubToken({})).not.toThrow();
  });

  it('does not mutate the passed-in env object', () => {
    const env = { GH_TOKEN: 'ghp_secret' };
    resolveGitHubToken(env);
    expect(env.GH_TOKEN).toBe('ghp_secret');
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN is whitespace', () => {
    const result = resolveGitHubToken({
      GH_TOKEN: '   ',
      GITHUB_TOKEN: 'ghp_fallback',
    });
    expect(result.token).toBe('ghp_fallback');
    expect(result.source).toBe('GITHUB_TOKEN');
  });
});

describe('hasGitHubToken', () => {
  it('returns true when GH_TOKEN is present', () => {
    expect(hasGitHubToken({ GH_TOKEN: 'ghp_abc' })).toBe(true);
  });

  it('returns true when only GITHUB_TOKEN is present', () => {
    expect(hasGitHubToken({ GITHUB_TOKEN: 'ghp_actions' })).toBe(true);
  });

  it('returns false when neither token is set', () => {
    expect(hasGitHubToken({})).toBe(false);
  });

  it('returns false when GH_TOKEN is empty and GITHUB_TOKEN absent', () => {
    expect(hasGitHubToken({ GH_TOKEN: '' })).toBe(false);
  });

  it('returns false when both tokens are empty strings', () => {
    expect(hasGitHubToken({ GH_TOKEN: '', GITHUB_TOKEN: '' })).toBe(false);
  });

  it('returns false when both tokens are whitespace', () => {
    expect(hasGitHubToken({ GH_TOKEN: '  ', GITHUB_TOKEN: '  ' })).toBe(false);
  });

  it('returns true when GH_TOKEN has a classic ghp_ prefix', () => {
    expect(hasGitHubToken({ GH_TOKEN: 'ghp_classic123' })).toBe(true);
  });

  it('returns true when GH_TOKEN has a fine-grained github_pat_ prefix', () => {
    expect(hasGitHubToken({ GH_TOKEN: 'github_pat_finegrained' })).toBe(true);
  });
});
