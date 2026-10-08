/**
 * Exact RFC 3339 timestamp handling.
 *
 * Google Chat `createTime` values carry sub-millisecond precision
 * (e.g. `2026-10-08T10:00:00.123456Z`). `Date` keeps only milliseconds, so
 * comparing, sorting, or shifting these through `Date` silently merges distinct
 * instants and moves query boundaries. Everything here works in integer
 * nanoseconds since the epoch instead.
 */

const RFC3339 = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/i;

/** Nanoseconds since the epoch, or null when `ts` is not an RFC 3339 timestamp. */
export function rfc3339ToNanos(ts: string | null | undefined): bigint | null {
  if (!ts) return null;
  const match = RFC3339.exec(ts.trim());
  if (!match) return null;
  const [, base, fraction = '', zone] = match;
  // Whole seconds are exact in Date; only the fraction needs care.
  const secondsMs = Date.parse(`${base}${zone.toUpperCase() === 'Z' ? 'Z' : zone}`);
  if (!Number.isFinite(secondsMs)) return null;
  return BigInt(secondsMs) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
}

/** Format nanoseconds as UTC RFC 3339 with all nine fractional digits. */
export function nanosToRfc3339(nanos: bigint): string {
  const seconds = nanos >= 0n ? nanos / 1_000_000_000n : (nanos - 999_999_999n) / 1_000_000_000n;
  const fraction = nanos - seconds * 1_000_000_000n;
  const whole = new Date(Number(seconds) * 1000).toISOString().slice(0, 19);
  return `${whole}.${fraction.toString().padStart(9, '0')}Z`;
}

/** `ts` moved by `deltaNanos`, exactly; null when `ts` does not parse. */
export function shiftRfc3339(ts: string, deltaNanos: bigint): string | null {
  const nanos = rfc3339ToNanos(ts);
  return nanos === null ? null : nanosToRfc3339(nanos + deltaNanos);
}

/**
 * Order two timestamps exactly. Unparseable or missing values sort before
 * every real timestamp so callers never lose a message to a NaN comparison.
 */
export function compareRfc3339(a: string | null | undefined, b: string | null | undefined): number {
  const na = rfc3339ToNanos(a);
  const nb = rfc3339ToNanos(b);
  if (na === null || nb === null) return na === nb ? 0 : na === null ? -1 : 1;
  return na < nb ? -1 : na > nb ? 1 : 0;
}

export function isRfc3339(ts: string): boolean {
  return rfc3339ToNanos(ts) !== null;
}
