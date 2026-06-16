import '../test/setup.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as usersStore from '../users-store.js';
import * as sessionOwnership from '../session-ownership.js';
import * as authStore from '../auth-store.js';
import {
  isKnownHubUserId,
  resolveNativePrAuthorUserId,
  PR_AUTHOR_SENTINELS,
  LOCAL_NO_AUTH_PR_AUTHOR,
} from './author-user.js';

/**
 * Force the auth-enabled code path: the global apiKey or a JWT auth record is
 * present, so no-auth / local-bundled attribution fallbacks do not apply. The
 * default test harness runs auth-disabled, so the throw path must opt in.
 */
function withAuthEnabled() {
  vi.spyOn(authStore, 'getAuthRecord').mockReturnValue({
    username: 'owner',
    passwordHash: 'h',
    jwtSecret: 's',
    role: 'Owner',
  } as never);
  const priorMode = process.env.AGENT_HUB_MODE;
  delete process.env.AGENT_HUB_MODE;
  return () => {
    if (priorMode === undefined) delete process.env.AGENT_HUB_MODE;
    else process.env.AGENT_HUB_MODE = priorMode;
  };
}

describe('isKnownHubUserId', () => {
  beforeEach(() => {
    vi.spyOn(usersStore, 'getUserById').mockReturnValue(null);
  });

  it('rejects sentinels', () => {
    for (const sentinel of PR_AUTHOR_SENTINELS) {
      expect(isKnownHubUserId(sentinel)).toBe(false);
    }
  });

  it('accepts a known user row', () => {
    vi.mocked(usersStore.getUserById).mockReturnValue({ id: 'user-1' } as never);
    expect(isKnownHubUserId('user-1')).toBe(true);
  });

  it('accepts non-sentinel ids when auth is disabled (test harness)', () => {
    expect(isKnownHubUserId('00000000-0000-4000-8000-000000000001')).toBe(true);
  });
});

describe('resolveNativePrAuthorUserId', () => {
  beforeEach(() => {
    vi.spyOn(usersStore, 'getUserById').mockReturnValue(null);
    vi.spyOn(sessionOwnership, 'getSessionOwner').mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prefers explicitUserId', () => {
    expect(
      resolveNativePrAuthorUserId({
        explicitUserId: '00000000-0000-4000-8000-000000000002',
        sessionId: 'sess-1',
        triggeredByUserId: '00000000-0000-4000-8000-000000000003',
      }),
    ).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('falls back to session owner then finalize trigger user', () => {
    vi.mocked(sessionOwnership.getSessionOwner).mockReturnValue(
      '00000000-0000-4000-8000-000000000004',
    );
    expect(
      resolveNativePrAuthorUserId({
        sessionId: 'sess-1',
        triggeredByUserId: '00000000-0000-4000-8000-000000000005',
      }),
    ).toBe('00000000-0000-4000-8000-000000000004');

    vi.mocked(sessionOwnership.getSessionOwner).mockReturnValue(null);
    expect(
      resolveNativePrAuthorUserId({
        triggeredByUserId: '00000000-0000-4000-8000-000000000006',
      }),
    ).toBe('00000000-0000-4000-8000-000000000006');
  });

  it('throws when no valid user can be resolved and auth is enabled', () => {
    const restore = withAuthEnabled();
    try {
      expect(() => resolveNativePrAuthorUserId({ sessionId: 'sess-1' })).toThrow(
        /attributed Hub user/,
      );
    } finally {
      restore();
    }
  });

  it('falls back to the local author when no user resolves and auth is disabled', () => {
    // Default harness runs auth-disabled (no apiKey, no auth record), matching
    // a fresh / no-auth install where authMiddleware runs requests as `local`.
    expect(resolveNativePrAuthorUserId({ sessionId: 'sess-1' })).toBe(LOCAL_NO_AUTH_PR_AUTHOR);
  });

  it('falls back to the local author in local-bundled mode even when auth is configured', () => {
    vi.spyOn(authStore, 'getAuthRecord').mockReturnValue({
      username: 'owner',
      passwordHash: 'h',
      jwtSecret: 's',
      role: 'Owner',
    } as never);
    const prior = process.env.AGENT_HUB_MODE;
    process.env.AGENT_HUB_MODE = 'local';
    try {
      expect(resolveNativePrAuthorUserId({ sessionId: 'sess-1' })).toBe(LOCAL_NO_AUTH_PR_AUTHOR);
    } finally {
      if (prior === undefined) delete process.env.AGENT_HUB_MODE;
      else process.env.AGENT_HUB_MODE = prior;
    }
  });
});
