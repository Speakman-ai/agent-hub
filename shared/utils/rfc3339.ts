/**
 * Exact RFC 3339 timestamp handling.
 *
 * Google Chat `createTime` values carry sub-millisecond precision
 * (e.g. `2026-10-08T10:00:00.123456Z`). `Date` keeps only milliseconds, so
 * comparing, sorting, or shifting these through `Date` silently merges distinct
 * instants and moves query boundaries. Everything here works in integer
 * nanoseconds since the epoch instead.
 */

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/i;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** Days since 1970-01-01 for a proleptic Gregorian date (Hinnant's days_from_civil). */
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Nanoseconds since the epoch, or null when `ts` is not a valid RFC 3339
 * timestamp. Every field is range-checked (no Feb 30, no 24:00, no leap
 * second, offsets within ±23:59) and the instant is computed arithmetically:
 * `Date.parse` would roll an impossible date into a different, real one.
 * `server/default-skills/google/scripts/google-chat.sh` mirrors these rules.
 */
export function rfc3339ToNanos(ts: string | null | undefined): bigint | null {
  if (!ts) return null;
  const match = RFC3339.exec(ts.trim());
  if (!match) return null;
  const [, ys, mos, ds, hs, mis, ss, fraction = '', zone, sign, ohs, oms] = match;
  const [year, month, day, hour, minute, second] = [ys, mos, ds, hs, mis, ss].map(Number);
  if (month < 1 || month > 12) return null;
  const monthDays = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
  if (day < 1 || day > monthDays) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  let offsetSeconds = 0;
  if (zone.toUpperCase() !== 'Z') {
    const oh = Number(ohs);
    const om = Number(oms);
    if (oh > 23 || om > 59) return null;
    offsetSeconds = (sign === '-' ? -1 : 1) * (oh * 3600 + om * 60);
  }
  const seconds =
    daysFromCivil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second - offsetSeconds;
  return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
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
