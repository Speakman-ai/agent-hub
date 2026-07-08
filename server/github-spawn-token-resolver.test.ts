import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  validateTokenForRepo,
  resolveGithubSpawnToken,
  clearInstallationLookupCache,
} from './github-spawn-token-resolver.js';

beforeEach(() => clearInstallationLookupCache());

describe('validateTokenForRepo', () => {
  it('returns false for empty inputs', async () => {
    const fetcher = vi.fn();
    expect(await validateTokenForRepo(null, 'a', 'b', fetcher as never)).toBe(false);
    expect(await validateTokenForRepo('t', '', 'b', fetcher as never)).toBe(false);
    expect(await validateTokenForRepo('t', 'a', '', fetcher as never)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns true on a 200 response', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200 }));
    expect(await validateTokenForRepo('token', 'acme', 'webapp', fetcher)).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/webapp',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'token token',
        }),
      }),
    );
  });

  it('returns false on a 401', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 401 }));
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });

  it('returns false on a 403', async () => {
    const fetcher = vi.fn(async () => ({ ok: false, status: 403 }));
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });

  it('returns false on a network error (does not throw)', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(await validateTokenForRepo('token', 'a', 'b', fetcher)).toBe(false);
  });
});

describe('resolveGithubSpawnToken', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it('non-reviewer interactive returns the per-user OAuth token when it validates', async () => {
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: 'gho_user_pat',
      repoOwner: 'acme',
      repoName: 'webapp',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBe('gho_user_pat');
  });

  it('non-reviewer interactive returns user OAuth without validation when only owner is known (no repo name)', async () => {
    const validate = vi.fn(async () => ({ ok: true, status: 200 }));
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: 'gho_user_pat',
      repoOwner: 'acme',
      validateFetcher: validate,
    });
    expect(token).toBe('gho_user_pat');
    expect(validate).not.toHaveBeenCalled();
  });

  it('non-reviewer interactive returns null when no user OAuth is stored', async () => {
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: null,
      repoOwner: 'acme',
      repoName: 'webapp',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBeNull();
  });

  it('non-reviewer interactive returns null and logs when user OAuth fails validation', async () => {
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: 'gho_dead_token',
      repoOwner: 'acme',
      repoName: 'webapp',
      validateFetcher: async () => ({ ok: false, status: 403 }),
    });
    expect(token).toBeNull();
    const lines = errSpy.mock.calls.map((c: unknown[]) => String(c[0] ?? '')).join('\n');
    expect(lines).toMatch(/user-oauth-token/);
  });

  it('reviewer role never receives a spawn-env token', async () => {
    // Reviewer sessions are isolated from GitHub by design; they get no
    // token even when a valid per-user OAuth is available.
    const token = await resolveGithubSpawnToken({
      role: 'reviewer',
      userGhToken: 'gho_user_pat',
      repoOwner: 'acme',
      repoName: 'webapp',
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    expect(token).toBeNull();
  });

  it('autonomous-dispatch non-reviewer returns null instead of falling back to user OAuth', async () => {
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: 'gho_user_pat',
      repoOwner: 'acme',
      repoName: 'webapp',
      autonomousOrigin: true,
      validateFetcher: async () => ({ ok: true, status: 200 }),
    });
    // Security invariant: autonomous-dispatch must NOT fall back to a
    // human's personal OAuth token, even if it would have validated.
    expect(token).toBeNull();
  });

  it('non-reviewer interactive returns user OAuth without validation when repo info is missing', async () => {
    const validate = vi.fn();
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: 'gho_user_pat',
      repoOwner: null,
      repoName: null,
      validateFetcher: validate as never,
    });
    expect(token).toBe('gho_user_pat');
    expect(validate).not.toHaveBeenCalled();
  });

  it('returns null when no user token is available', async () => {
    const token = await resolveGithubSpawnToken({
      role: 'developer',
      userGhToken: null,
    });
    expect(token).toBeNull();
  });
});
