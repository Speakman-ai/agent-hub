/**
 * Shared primitives for the preview runtime layer.
 *
 * These are the injection seams the dev-server runtime and its wiring
 * depend on: a port range, an injectable clock, and a minimal health
 * fetch surface. They live apart from `dev-server-runtime.ts` so the
 * setup layer and tests can import them without pulling in the runtime.
 */

/** Inclusive port range the runtime allocates host ports from. */
export interface PortRange {
  readonly min: number;
  readonly max: number;
}

/** Tiny clock so tests can step time without `vi.useFakeTimers()`. */
export interface Clock {
  nowMs(): number;
  nowIso(): string;
  /** Resolve after `ms` real or simulated milliseconds. */
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowIso: () => new Date().toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** A 2xx-or-network-error fetch surface. */
export type HealthFetchFn = (
  url: string,
  timeoutMs?: number,
) => Promise<{ ok: boolean; status: number }>;

/** Cadence for the dev-server reap pass — every 60 seconds. */
export const PREVIEW_REAPER_CRON = '* * * * *';

/**
 * Parse the `datetime('now')` / ISO format that SQLite emits without a
 * trailing Z. Returns null on missing/unparseable input so callers can
 * skip the row instead of NaN-bombing the comparison.
 */
export function parseDbTime(raw: string | null): number | null {
  if (!raw) return null;
  const normalised = raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z';
  const parsed = Date.parse(normalised);
  return Number.isFinite(parsed) ? parsed : null;
}
