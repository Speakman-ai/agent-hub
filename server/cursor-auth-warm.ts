// Pre-spawn Cursor OAuth warm-up.
//
// The Cursor CLI renews its OAuth token as a *side effect* of
// `cursor-agent status`. It does NOT renew on the paths chat actually uses —
// `cursor-agent -p …` and `cursor-agent create-chat`. That asymmetry produces
// two user-visible failures once the on-disk token in
// `<per-user HOME>/.config/cursor/auth.json` passes its `exp`:
//
//   1. The spawn dies with "Authentication required. Please run 'agent login'
//      first, or set CURSOR_API_KEY" and the session fails over to another
//      engine — while Account settings shows Cursor as logged in, because
//      opening that panel runs the status probe, which *repairs* the token.
//   2. `cursor-agent create-chat` can sleep indefinitely instead of erroring,
//      stranding the turn (see `cursor-create-chat.ts` for the timeout rail).
//
// Warming the token before the spawn turns both into a self-heal: we run the
// same `status --format json` probe the Account-settings route runs, under the
// owner's per-user HOME, so the CLI rewrites auth.json before we spawn.
//
// The probe is memoized by `cursor-auth-cache` (60s, scoped per user) so a
// burst of turns costs one exec, and the cached answer stays consistent with
// what `GET /api/config/models` reports.

import { probeCursorStatus } from './engine-auth-status.js';
import {
  getCursorAuthenticatedCached,
  invalidateCursorAuthCacheForScope,
} from './cursor-auth-cache.js';
import { ensurePerUserHome } from './per-user-home.js';
import { getUserCursorAuth } from './users-store.js';

export interface WarmCursorAuthOpts {
  cursorBin: string;
  userId: string | null;
  dataDir: string | null;
  /** Injectable probe — `(bin, home) => authenticated`. Tests override this. */
  probe?: (bin: string, home: string) => Promise<boolean>;
  /** Injectable stored-API-key lookup. Tests override this. */
  readStoredApiKey?: (userId: string) => string | null;
}

export interface WarmCursorAuthHomeOpts {
  cursorBin: string;
  /** Pre-resolved CLI HOME — normally the spawn env's pinned `HOME`. */
  home: string | null | undefined;
  /** Injectable probe — `(bin, home) => authenticated`. Tests override this. */
  probe?: (bin: string, home: string) => Promise<boolean>;
}

/**
 * Same warm-up keyed on an already-resolved HOME rather than a Hub user id.
 *
 * One-shot spawns (crons, heartbeats, analyze, skill evals) receive a spawn
 * env whose `HOME` is already pinned to the owner's per-user tree by
 * `buildSpawnEnv`, but carry no user id through their call chain. They cannot
 * strand a session (every one-shot spawn is timeout-bounded), yet an expired
 * token still makes them fail and burn a failover hop, so they get the same
 * renewal.
 */
export async function warmCursorAuthForHome(opts: WarmCursorAuthHomeOpts): Promise<boolean> {
  const { cursorBin, home } = opts;
  if (!cursorBin?.trim() || !home?.trim()) return false;
  const probe =
    opts.probe ?? ((bin: string, h: string) => probeCursorStatus(bin, { env: { HOME: h } }));
  try {
    return await runWarmProbe(cursorBin, home, `home:${home}`, probe);
  } catch (err) {
    console.warn(`[cursor-auth-warm] warm-up failed for HOME ${home}: ${warmFailureSummary(err)}`);
    return false;
  }
}

/**
 * Probe once, and retry once on a negative answer.
 *
 * An expired token makes the first `status` kick off the renewal but still
 * report `isAuthenticated: false` while auth.json is mid-rewrite (observed:
 * status #1 -> hasAccessToken false, status #2 -> authenticated with a token
 * expiring 60 days out). One retry picks up the renewed credential.
 */
async function runWarmProbe(
  cursorBin: string,
  home: string,
  scope: string,
  probe: (bin: string, home: string) => Promise<boolean>,
): Promise<boolean> {
  const ok = await getCursorAuthenticatedCached(cursorBin, (bin) => probe(bin, home), { scope });
  if (ok) return true;
  invalidateCursorAuthCacheForScope(cursorBin, scope);
  return await getCursorAuthenticatedCached(cursorBin, (bin) => probe(bin, home), { scope });
}

/**
 * Refresh the acting user's Cursor OAuth token before a cursor spawn.
 *
 * Returns `true` when Cursor reports an authenticated session afterwards.
 * Never throws — a warm-up failure must not block the spawn, which has its own
 * error and failover handling.
 */
export async function warmCursorAuthForSpawn(opts: WarmCursorAuthOpts): Promise<boolean> {
  const { cursorBin, userId, dataDir } = opts;
  if (!cursorBin?.trim() || !userId?.trim() || !dataDir?.trim()) return false;

  try {
    // API-key auth carries no refreshable token — nothing to warm.
    const readKey =
      opts.readStoredApiKey ?? ((id: string) => getUserCursorAuth(id)?.apiKey ?? null);
    if (readKey(userId)?.trim()) return true;

    const home = ensurePerUserHome(userId, dataDir);
    const probe =
      opts.probe ?? ((bin: string, h: string) => probeCursorStatus(bin, { env: { HOME: h } }));
    return await runWarmProbe(cursorBin, home, `uid:${userId}`, probe);
  } catch (err) {
    console.warn(
      `[cursor-auth-warm] warm-up failed for user ${userId}: ${warmFailureSummary(err)}`,
    );
    return false;
  }
}

/** One-line, pipe-free rendering of a warm-up failure for the operator log. */
function warmFailureSummary(err: unknown): string {
  return String((err as Error)?.message ?? err)
    .replace(/[\r\n|]+/g, ' ')
    .trim()
    .slice(0, 200);
}
