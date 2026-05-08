import { describe, it, expect } from 'vitest';
import { resolveLinearApiKey, hasLinearApiKey } from './linear-skill-auth-resolve.js';

describe('resolveLinearApiKey', () => {
  it('returns the key when LINEAR_API_KEY is set', () => {
    const result = resolveLinearApiKey({ LINEAR_API_KEY: 'lin_api_abc123' });
    expect(result.apiKey).toBe('lin_api_abc123');
    expect(result.fromEnv).toBe(true);
  });

  it('returns undefined when LINEAR_API_KEY is absent', () => {
    const result = resolveLinearApiKey({});
    expect(result.apiKey).toBeUndefined();
    expect(result.fromEnv).toBe(false);
  });

  it('returns undefined when LINEAR_API_KEY is explicitly set to empty string', () => {
    const result = resolveLinearApiKey({ LINEAR_API_KEY: '' });
    expect(result.apiKey).toBeUndefined();
    expect(result.fromEnv).toBe(false);
  });

  it('returns undefined when LINEAR_API_KEY is whitespace-only', () => {
    const result = resolveLinearApiKey({ LINEAR_API_KEY: '   ' });
    expect(result.apiKey).toBeUndefined();
    expect(result.fromEnv).toBe(false);
  });

  it('trims surrounding whitespace from a valid key', () => {
    const result = resolveLinearApiKey({ LINEAR_API_KEY: '  lin_api_abc123\n' });
    expect(result.apiKey).toBe('lin_api_abc123');
    expect(result.fromEnv).toBe(true);
  });

  it('never throws when env is empty', () => {
    expect(() => resolveLinearApiKey({})).not.toThrow();
  });

  it('does not mutate the passed-in env object', () => {
    const env = { LINEAR_API_KEY: 'lin_api_secret' };
    resolveLinearApiKey(env);
    expect(env.LINEAR_API_KEY).toBe('lin_api_secret');
  });

  it('ignores unrelated environment variables', () => {
    const result = resolveLinearApiKey({ GITHUB_TOKEN: 'ghp_xyz', NODE_ENV: 'test' });
    expect(result.apiKey).toBeUndefined();
    expect(result.fromEnv).toBe(false);
  });
});

describe('hasLinearApiKey', () => {
  it('returns true when key is present', () => {
    expect(hasLinearApiKey({ LINEAR_API_KEY: 'lin_api_abc' })).toBe(true);
  });

  it('returns false when key is absent', () => {
    expect(hasLinearApiKey({})).toBe(false);
  });

  it('returns false when key is empty string', () => {
    expect(hasLinearApiKey({ LINEAR_API_KEY: '' })).toBe(false);
  });
});
