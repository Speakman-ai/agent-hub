/**
 * Browser-local helpers for scheduling a native PR auto-merge. The client
 * sends the picked wall-clock time plus the device's IANA zone; the server
 * converts to UTC. Displays always render the stored UTC instant locally.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** Local wall-clock `YYYY-MM-DDTHH:mm` (the `datetime-local` input format). */
export function toLocalDateTimeValue(date: Date): string {
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** Parse a `YYYY-MM-DDTHH:mm` wall-clock value as a local Date (null if malformed). */
export function parseLocalDateTimeValue(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Default pick: the top of the next hour, at least 15 minutes out. */
export function defaultScheduleDate(now: Date = new Date()): Date {
  const d = new Date(now.getTime() + 15 * 60_000);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

/** The device's IANA time zone, or UTC when the runtime can't tell. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** True when `value` is a well-formed local time strictly after `now`. */
export function isFutureLocalDateTime(value: string, now: Date = new Date()): boolean {
  const d = parseLocalDateTimeValue(value);
  return d !== null && d.getTime() > now.getTime();
}

/** "Tue, Oct 13, 9:30 AM" in the device's locale/zone, or null when unset. */
export function formatScheduledAutoMerge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
