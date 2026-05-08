import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getCursorAuthenticatedCached,
  invalidateCursorAuthCache,
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
    expect(_peekCursorAuthCacheForTests()).toMatchObject({
      bin: '/usr/local/bin/cursor-agent',
      value: false,
    });

    invalidateCursorAuthCache();
    expect(_peekCursorAuthCacheForTests()).toBeNull();

    expect(await getCursorAuthenticatedCached('/usr/local/bin/cursor-agent', probe)).toBe(true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('invalidate() is idempotent and safe to call when the cache is empty', () => {
    invalidateCursorAuthCache();
    invalidateCursorAuthCache();
    expect(_peekCursorAuthCacheForTests()).toBeNull();
  });
});
