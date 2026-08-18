import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./connection', () => ({
  getApiBase: () => '/api',
  getAuthHeaders: () => ({}),
}));

const clearToken = vi.fn();
// These cases exercise the hosted (non-local) dead-session path, so
// `isLocalBundledDeployment` stays false. Local bundled mode is covered separately in
// api.unauthorized.test.ts, which uses the real ./auth module.
vi.mock('./auth', () => ({
  getToken: () => 'jwt-token',
  clearToken: () => clearToken(),
  isLocalBundledDeployment: () => false,
}));

import { api, errorDetail, fetchTimeoutMessage, isFetchTimeoutError } from './api';

const reload = vi.fn();
const originalLocation = window.location;

beforeEach(() => {
  clearToken.mockReset();
  reload.mockReset();
  sessionStorage.clear();
  // jsdom's location.reload is non-configurable and throws "Not
  // implemented" when called. `window.location` itself IS configurable, so
  // replace the whole object with a minimal stub carrying a spy reload.
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: { href: 'http://localhost/', reload },
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: originalLocation,
  });
  vi.restoreAllMocks();
});

function mockFetchOnce(status: number, body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe('fetchJSON dead-session handling', () => {
  it('treats a no_active_org_membership 403 as a dead session: clears the token and reloads', async () => {
    mockFetchOnce(403, {
      error: 'You are not a member of this org.',
      code: 'no_active_org_membership',
    });

    await expect(api.getProjects()).rejects.toThrow(/403/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves an ordinary permission 403 alone (no token clear, no reload)', async () => {
    mockFetchOnce(403, { error: 'Owner role required.' });

    await expect(api.getProjects()).rejects.toThrow(/403/);
    expect(clearToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('still clears the token and reloads on a tagged 401', async () => {
    mockFetchOnce(401, { error: 'Token is no longer valid.', code: 'invalid_session' });

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('leaves an untagged 401 alone (unconnected integration, not a dead session)', async () => {
    mockFetchOnce(401, { error: 'Connect your GitHub account in Settings → GitHub.' });

    await expect(api.getProjects()).rejects.toThrow(/401/);
    expect(clearToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});

/**
 * The `/auth/me/*` engine-credential routes emit two different 401s:
 *
 *   - `code: 'no_user_identity'` — the caller authenticated fine, but has
 *     no per-user `users` row (legacy global apiKey, local-bundled or
 *     no-auth-configured bypass). Recoverable; the panels render an empty
 *     state. Reloading here clears a working token and kicks the user out
 *     of SetupWizard.
 *   - `code: 'invalid_session'` — a genuinely dead session (expired /
 *     revoked JWT), which must still bounce to LoginScreen. `authMiddleware`
 *     rejects these before the route body runs, so the tag is always present.
 *
 * Regression: the opt-out used to be a per-callsite `deadSessionOnUnauthorized:
 * false` flag applied to the mutating `putMy*Auth` helpers as well as the
 * read probes. That swallowed expired-session 401s on writes, leaving the
 * client authenticated-but-dead with a silently failed save. Scope it by
 * the server's code instead, so the verb doesn't matter — only which 401.
 */
describe('fetchJSON — /auth/me/* 401 disambiguation', () => {
  it('does not reload on a no_user_identity 401 read probe', async () => {
    mockFetchOnce(401, { error: 'Authentication required', code: 'no_user_identity' });

    await expect(api.getMyClaudeAuth()).rejects.toThrow(/401/);
    expect(clearToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('does not reload on a no_user_identity 401 write either', async () => {
    mockFetchOnce(401, { error: 'Authentication required', code: 'no_user_identity' });

    await expect(api.putMyClaudeAuth({ anthropicApiKey: 'sk-test' })).rejects.toThrow(/401/);
    expect(clearToken).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('treats an invalid_session 401 on a credential WRITE as a dead session', async () => {
    // The reviewer's case: an expired hosted JWT hitting PUT. Previously
    // swallowed, leaving the app in a dead authenticated state.
    mockFetchOnce(401, { error: 'Token is no longer valid.', code: 'invalid_session' });

    await expect(api.putMyCursorAuth({ apiKey: 'k' })).rejects.toThrow(/401/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('treats an invalid_session 401 on a credential READ as a dead session', async () => {
    mockFetchOnce(401, { error: 'Token is no longer valid.', code: 'invalid_session' });

    await expect(api.getMyGrokAuth()).rejects.toThrow(/401/);
    expect(clearToken).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

function timeoutError(message = 'The operation was aborted due to timeout'): Error {
  const err = new Error(message);
  err.name = 'TimeoutError';
  return err;
}

describe('fetchJSON AbortSignal timeout', () => {
  it('remaps TimeoutError from its own signal to method + path + deadline', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError());

    await expect(api.getProjects()).rejects.toThrow(
      'Request timed out after 15000ms: GET /projects',
    );
  });

  it('includes a caller-specified timeout in the remapped message', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError());

    await expect(api.summarizeSession('sess-1')).rejects.toThrow(
      'Request timed out after 120000ms: POST /sessions/sess-1/summarize',
    );
  });

  it('does not remap TimeoutError when the caller supplied the AbortSignal', async () => {
    const raw = timeoutError();
    globalThis.fetch = vi.fn().mockRejectedValue(raw);
    const signal = new AbortController().signal;

    await expect(api.getReviewerThreads('proj-1', 'run-1', { signal })).rejects.toBe(raw);
  });

  it('does not remap a non-timeout fetch failure', async () => {
    const raw = new TypeError('Failed to fetch');
    globalThis.fetch = vi.fn().mockRejectedValue(raw);

    await expect(api.getProjects()).rejects.toBe(raw);
  });
});

describe('isFetchTimeoutError / fetchTimeoutMessage', () => {
  it('recognizes TimeoutError by name', () => {
    expect(isFetchTimeoutError(timeoutError())).toBe(true);
    expect(isFetchTimeoutError(new Error('The operation was aborted due to timeout'))).toBe(false);
    expect(isFetchTimeoutError('timeout')).toBe(false);
  });

  it('keeps the TimeoutError name and original cause on the remapped error', async () => {
    const raw = timeoutError();
    globalThis.fetch = vi.fn().mockRejectedValue(raw);

    const err = await api.getProjects().then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.name).toBe('TimeoutError');
    expect(isFetchTimeoutError(err)).toBe(true);
    expect(err!.cause).toBe(raw);
  });

  it('names the request that died', () => {
    expect(fetchTimeoutMessage('GET', '/projects', 15000)).toBe(
      'Request timed out after 15000ms: GET /projects',
    );
  });
});

describe('errorDetail', () => {
  it('prefers the human message over a machine error code', () => {
    // "400: no_pushable_commits" tells an operator nothing; the paired message
    // says which state they are in and what to do about it.
    expect(
      errorDetail(
        { error: 'no_pushable_commits', message: 'This branch has no committed changes.' },
        400,
      ),
    ).toBe('400: This branch has no committed changes.');
  });

  it('keeps an error field that is already human copy', () => {
    expect(errorDetail({ error: 'agentId is required' }, 400)).toBe('400: agentId is required');
  });

  it('falls back to the code when no message is present', () => {
    expect(errorDetail({ error: 'no_worktree' }, 400)).toBe('400: no_worktree');
  });

  it('falls back to the status when the body carries nothing usable', () => {
    expect(errorDetail(null, 500)).toBe('API error: 500');
    expect(errorDetail({}, 500)).toBe('500: {}');
  });
});
