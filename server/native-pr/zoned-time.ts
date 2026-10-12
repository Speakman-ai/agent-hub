/**
 * Convert a browser-local wall-clock time ("2026-10-13T09:30") in an IANA
 * time zone ("America/Chicago") to a UTC instant, without a tz library.
 *
 * Clients send what the user picked plus their zone so the conversion (and
 * its DST handling) happens server-side against the zone's real rules.
 */

const WALL_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export class ZonedTimeError extends Error {}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `timeZone` from UTC at instant `utcMs`; positive east of UTC. */
function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wallAsUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Wall time in `timeZone` → UTC epoch ms. A time inside a spring-forward gap
 * resolves to the instant just after the gap (e.g. 02:30 → 03:30 local);
 * an ambiguous fall-back time resolves to its first occurrence.
 */
export function zonedWallTimeToUtcMs(local: string, timeZone: string): number {
  const m = WALL_TIME_RE.exec(local);
  if (!m) throw new ZonedTimeError('localDateTime must look like YYYY-MM-DDTHH:mm');
  if (!isValidTimeZone(timeZone)) throw new ZonedTimeError(`Unknown time zone: ${timeZone}`);
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(asUtc);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    throw new ZonedTimeError(`Invalid date/time: ${local}`);
  }
  // Offsets either side of any DST transition near this wall time. A
  // candidate is valid when the zone's offset at that instant reproduces the
  // wall time. Two valid = ambiguous (fall back): take the first. None valid
  // = gap (spring forward): the pre-gap offset lands just after the gap.
  const DAY = 86_400_000;
  const before = zoneOffsetMs(timeZone, asUtc - DAY);
  const after = zoneOffsetMs(timeZone, asUtc + DAY);
  const valid = [asUtc - before, asUtc - after].filter(
    (c) => zoneOffsetMs(timeZone, c) === asUtc - c,
  );
  if (valid.length > 0) return Math.min(...valid);
  return asUtc - before;
}
