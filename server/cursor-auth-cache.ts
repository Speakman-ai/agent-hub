// Module-scoped cache for the result of `cursor-agent status`.
//
// `GET /api/config/models` is polled by the SPA on a tight cadence (engine
// picker, Settings tabs, the SetupWizard "Save & Continue" check). Spawning
// `cursor-agent status` on every poll is wasteful and fights the wizard
// against itself, so we memoize the result for a short window per resolved
// `cursorBin`.
//
// The cache must be invalidated whenever the underlying authentication state
// could have changed. Two events qualify:
//
//   1. The configured `cursorBin` is rewritten — handled implicitly because
//      the cache is keyed on the resolved bin string (a different key misses
//      the cache), AND explicitly via `invalidateCursorAuthCache()` so a
//      bin change clears any stale entry for the *new* bin too (the wizard
//      can resolve the same path it had before and we still need to drop
//      a cached `false`).
//   2. The user just completed `cursor-agent login` / `cursor-agent logout`.
//      In this case the bin path is unchanged but the answer flipped, so the
//      cached value is wrong until the TTL expires. The wizard's Save check
//      hits this exact race: status probes report `authenticated`, but the
//      cached models check still says `false` for up to 60s. Invalidating
//      on login/logout completion keeps the two views in sync.
//
// The cache lives in its own module (rather than inside `routes/config.ts`)
// so any route that mutates auth state (config PATCH, setup/configure,
// cursor-auth login/logout) can import the invalidator without dragging it
// through `RouteDeps`. Tests get a `_resetForTests` hook to clear state
// between cases.

const CURSOR_AUTH_CACHE_MS = 60_000;

interface CacheEntry {
  bin: string;
  value: boolean;
  ts: number;
}

let cache: CacheEntry | null = null;

/**
 * Probe `cursor-agent status` and cache the result for `CURSOR_AUTH_CACHE_MS`.
 * The probe function is passed in by the caller so this module stays free of
 * `child_process` plumbing and is trivial to test.
 */
export async function getCursorAuthenticatedCached(
  cursorBin: string,
  probe: (bin: string) => Promise<boolean>,
): Promise<boolean> {
  const now = Date.now();
  if (cache && cache.bin === cursorBin && now - cache.ts < CURSOR_AUTH_CACHE_MS) {
    return cache.value;
  }
  const value = await probe(cursorBin);
  cache = { bin: cursorBin, value, ts: now };
  return value;
}

/**
 * Drop any cached cursor-auth result. Call this whenever the bin path may
 * have changed or the user's login state may have flipped (login complete,
 * logout, manual config edit, …). Idempotent and cheap.
 */
export function invalidateCursorAuthCache(): void {
  cache = null;
}

/** Test-only — reset module state between cases. */
export function _resetCursorAuthCacheForTests(): void {
  cache = null;
}

/** Test-only — peek at the current cache entry without taking the fast path. */
export function _peekCursorAuthCacheForTests(): CacheEntry | null {
  return cache;
}

export const _CURSOR_AUTH_CACHE_MS_FOR_TESTS = CURSOR_AUTH_CACHE_MS;
