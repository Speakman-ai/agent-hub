/**
 * Exponential backoff schedule for job retries.
 *
 * Pure and deterministic given its inputs (jitter is opt-in and takes an
 * injected RNG), so the retry-delay math is unit-testable without timers.
 *
 * The delay for attempt N (1-based — the attempt that just failed) is
 *   baseMs * factor^(N-1)
 * clamped to `[0, maxMs]`. Optional full jitter multiplies the clamped delay
 * by a random value in `[0, 1)` (AWS "full jitter"), which spreads retries so
 * a batch of jobs that failed together don't stampede the queue in lockstep.
 */

export interface BackoffOptions {
  /** Delay for the first retry, in milliseconds. Default 1000. */
  baseMs?: number;
  /** Multiplier applied per attempt. Default 2. */
  factor?: number;
  /** Hard ceiling on the delay, in milliseconds. Default 5 minutes. */
  maxMs?: number;
  /** When true, apply AWS "full jitter" using `rng`. Default false. */
  jitter?: boolean;
  /** RNG in [0, 1); injected for deterministic tests. Default Math.random. */
  rng?: () => number;
}

export const DEFAULT_BACKOFF: Required<Omit<BackoffOptions, 'rng'>> = {
  baseMs: 1000,
  factor: 2,
  maxMs: 5 * 60 * 1000,
  jitter: false,
};

/**
 * Compute the retry delay (ms) for the attempt that just failed.
 *
 * @param attempt 1-based count of attempts already made (>= 1). Values < 1 are
 *   treated as 1 so the first retry always uses `baseMs`.
 */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BACKOFF.baseMs;
  const factor = opts.factor ?? DEFAULT_BACKOFF.factor;
  const maxMs = opts.maxMs ?? DEFAULT_BACKOFF.maxMs;
  const jitter = opts.jitter ?? DEFAULT_BACKOFF.jitter;
  const rng = opts.rng ?? Math.random;

  const n = Math.max(1, Math.floor(attempt));
  // Guard against Infinity from a huge exponent before clamping.
  const raw = baseMs * Math.pow(factor, n - 1);
  const clamped = Math.min(maxMs, Number.isFinite(raw) ? raw : maxMs);
  if (!jitter) return Math.max(0, Math.round(clamped));
  return Math.max(0, Math.round(clamped * rng()));
}
