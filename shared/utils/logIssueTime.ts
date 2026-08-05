/**
 * Largest millisecond epoch `Date` can represent: ±100,000,000 days around the
 * epoch, per ECMA-262 §21.4.1.1. `new Date(MAX_DATE_MS)` is valid;
 * `new Date(MAX_DATE_MS + 1)` is an Invalid Date.
 */
export const MAX_DATE_MS = 8.64e15;

/**
 * Unit conversion for issue-group "seen" timestamps.
 *
 * `LogIssue.firstSeen` / `lastSeen` (and the per-release facet) are copied
 * verbatim from the OTLP record's `time_unix_nano`, so they cross the wire in
 * epoch **nanoseconds**. Every date formatter in the clients takes epoch
 * **milliseconds**. Handing a nanosecond value to `new Date()` lands ~1000x past
 * the epoch, past the JS Date range (8.64e15), which yields an Invalid Date —
 * the relative-time helper then returns '' and the row falls back to reading
 * "just now" for every issue no matter how old it is.
 *
 * Route every issue timestamp through this before formatting.
 *
 * **Invariant:** a non-null result always satisfies `!isNaN(new Date(ms))`.
 * Callers render a non-null result directly, so anything that formats to
 * `1970-01-01`, `Invalid Date`, or an empty string must come back as `null`
 * instead — `null` means "no usable timestamp", and callers omit the field
 * rather than showing a fabricated or broken one.
 *
 * Every check therefore runs on the *converted* value, not the input:
 *   - Under `1e6` ns is under a millisecond past the epoch and floors to `0`,
 *     which formats as a real-looking `1970-01-01`. (This also subsumes the
 *     non-positive input check — negatives floor to `<= 0`.)
 *   - Over `MAX_DATE_MS` ns is past the range `Date` can represent, so it
 *     formats as `Invalid Date`.
 * Both mean garbage from a misconfigured ingest client, not a real timestamp.
 */
export function logIssueSeenMs(timeUnixNano: number | null | undefined): number | null {
  if (typeof timeUnixNano !== 'number' || !Number.isFinite(timeUnixNano)) return null;
  const ms = Math.floor(timeUnixNano / 1e6);
  if (ms <= 0 || ms > MAX_DATE_MS) return null;
  return ms;
}
