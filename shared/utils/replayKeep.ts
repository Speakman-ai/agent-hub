/**
 * Keep (extended retention) state for replay players and playlists, shared by web and mobile. Whether a Keep is active
 * depends on the clock, not just on the stored timestamp: a `retainedUntil` that
 * has passed protects nothing. So the state is always computed for a given
 * `nowMs` (at render, at click time, and when the expiry timer fires) instead of
 * being read from a value captured earlier.
 */
export type KeepState = 'off' | 'kept' | 'pending';

/** Parse a SQLite-UTC `YYYY-MM-DD HH:MM:SS` instant to epoch ms (NaN if invalid). */
export function parseSqliteUtc(value: string): number {
  return Date.parse(`${value.replace(' ', 'T')}Z`);
}

export function keepStateAt(
  retainedUntil: string | null | undefined,
  relocationPending: boolean,
  nowMs: number,
): KeepState {
  if (!retainedUntil) return 'off';
  const until = parseSqliteUtc(retainedUntil);
  if (!Number.isFinite(until) || until <= nowMs) return 'off';
  return relocationPending ? 'pending' : 'kept';
}

/** Whether a playlist's Keep is active at `nowMs`. */
export function isPlaylistKept(
  pl: { extendedRetention?: boolean; retainedUntil?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  return Boolean(pl?.extendedRetention) && keepStateAt(pl?.retainedUntil, false, nowMs) === 'kept';
}

/** setTimeout clamps delays above 2^31-1 ms (~24.8 days) to 1 ms. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * How long until the Keep lapses and the button should re-render as off, capped
 * to a safe timer delay (the timer re-arms on wake). Null when there is nothing
 * to wait for.
 */
export function keepRefreshDelayMs(
  retainedUntil: string | null | undefined,
  nowMs: number,
): number | null {
  if (!retainedUntil) return null;
  const until = parseSqliteUtc(retainedUntil);
  if (!Number.isFinite(until) || until <= nowMs) return null;
  return Math.min(until - nowMs + 1, MAX_TIMER_DELAY_MS);
}
