import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCursorAuthenticatedCached,
  invalidateCursorAuthCache,
  invalidateCursorAuthCacheForScope,
  _resetCursorAuthCacheForTests,
  _peekCursorAuthCacheForTests,
} from './cursor-auth-cache.js';

describe('cursor-auth-cache', () => {
  beforeEach(() => {
    _resetCursorAuthCacheForTests();
  });

  it('memoizes the probe result for the same bin within the TTL', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    expect(await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', probe)).toBe(true);
    expect(await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the bin path changes', async () => {
    const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(await getCursorAuthenticatedCached('/old/cursor-agent', probe)).toBe(false);
    expect(await getCursorAuthenticatedCached('/new/cursor-agent', probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenNthCalledWith(1, '/old/cursor-agent');
    expect(probe).toHaveBeenNthCalledWith(2, '/new/cursor-agent');
  });

  it('invalidate() drops the cached entry so the next call re-probes', async () => {
    // This is the wizard race: the cache says `false` from a pre-login poll,
    // the user finishes `cursor-agent login`, and the post-configure check
    // must NOT keep returning the stale `false` while the TTL is still warm.
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false) // initial poll (pre-login)
      .mockResolvedValueOnce(true); // re-probe after invalidate (post-login)

    expect(await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', probe)).toBe(false);
    expect(_peekCursorAuthCacheForTests('/usr/local/bin/cursor-agent')).toMatchObject({
      bin: '/usr/local/bin/cursor-agent',
      value: false,
    });

    invalidateCursorAuthCache();
    expect(_peekCursorAuthCacheForTests('/usr/local/bin/cursor-agent')).toBeNull();

    expect(await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('invalidate() is idempotent and safe to call when the cache is empty', () => {
    invalidateCursorAuthCache();
    invalidateCursorAuthCache();
    expect(_peekCursorAuthCacheForTests('/usr/local/bin/cursor-agent')).toBeNull();
  });

  it('invalidateForScope() drops only the targeted (bin, scope) entry', async () => {
    // Per-user login closing should re-probe ONLY the user whose HOME just
    // changed — every other user's cached answer must survive. Without this
    // guard a multi-tenant install would force every active user into a
    // spurious `cursor-agent status` round-trip whenever any one user
    // finished logging in.
    const probe = vi.fn().mockResolvedValue(true);

    // Seed three entries: host-level, user-a, user-b.
    await getCursorAuthenticatedCached('/cursor', probe);
    await getCursorAuthenticatedCached('/cursor', probe, { scope: 'uid:user-a' });
    await getCursorAuthenticatedCached('/cursor', probe, { scope: 'uid:user-b' });
    expect(probe).toHaveBeenCalledTimes(3);

    // Invalidate ONLY user-a's entry.
    invalidateCursorAuthCacheForScope('/cursor', 'uid:user-a');
    expect(_peekCursorAuthCacheForTests('/cursor')).not.toBeNull(); // host kept
    expect(_peekCursorAuthCacheForTests('/cursor', 'uid:user-a')).toBeNull(); // user-a dropped
    expect(_peekCursorAuthCacheForTests('/cursor', 'uid:user-b')).not.toBeNull(); // user-b kept
  });

  it('invalidateForScope() is idempotent on a missing entry', () => {
    invalidateCursorAuthCacheForScope('/cursor', 'uid:nobody');
    expect(_peekCursorAuthCacheForTests('/cursor', 'uid:nobody')).toBeNull();
  });

  it('invalidateForScope() with no scope targets the host-level entry only', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    await getCursorAuthenticatedCached('/cursor', probe);
    await getCursorAuthenticatedCached('/cursor', probe, { scope: 'uid:user-a' });

    invalidateCursorAuthCacheForScope('/cursor');
    expect(_peekCursorAuthCacheForTests('/cursor')).toBeNull();
    expect(_peekCursorAuthCacheForTests('/cursor', 'uid:user-a')).not.toBeNull();
  });

  it('scopes cache entries per uid so host + user probes do not collide', async () => {
    const calls: string[] = [];
    await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', async () => {
      calls.push('host');
      return true;
    });
    await getCursorAuthenticatedCached(
      '/usr/local/bin/cursor-agent',
      async () => {
        calls.push('user');
        return false;
      },
      { scope: 'uid:user-a' },
    );
    expect(calls).toEqual(['host', 'user']);

    await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', async () => {
      calls.push('host-repeat');
      return false;
    });
    await getCursorAuthenticatedCached(
      '/usr/local/bin/cursor-agent',
      async () => {
        calls.push('user-repeat');
        return true;
      },
      { scope: 'uid:user-a' },
    );
    expect(calls).toEqual(['host', 'user']);
  });
});
