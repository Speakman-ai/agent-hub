export type CalendarEventTime = {
  date?: string | null;
  dateTime?: string | null;
  timeZone?: string | null;
};

export type CalendarEventLike = {
  id?: string | null;
  summary?: string | null;
  description?: string | null;
  location?: string | null;
  htmlLink?: string | null;
  start?: CalendarEventTime | null;
  end?: CalendarEventTime | null;
};

export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function defaultCalendarRange(now = new Date()): { timeMin: string; timeMax: string } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return {
    timeMin: start.toISOString(),
    timeMax: addDays(start, 7).toISOString(),
  };
}

export function eventStartMillis(event: CalendarEventLike): number {
  const raw = event.start?.dateTime || event.start?.date;
  if (!raw) return 0;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

export function sortCalendarEvents<T extends CalendarEventLike>(events: T[] = []): T[] {
  return [...events].sort((a, b) => eventStartMillis(a) - eventStartMillis(b));
}

export function eventTimeLabel(event: CalendarEventLike): string {
  if (event.start?.date) {
    const start = new Date(`${event.start.date}T00:00:00`);
    return Number.isNaN(start.getTime()) ? event.start.date : start.toLocaleDateString();
  }
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || Number.isNaN(start.getTime())) return 'Time not set';
  const date = start.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startTime = start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const endTime =
    end && !Number.isNaN(end.getTime())
      ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : '';
  return `${date}, ${startTime}${endTime ? ` to ${endTime}` : ''}`;
}

/** Weeks rendered by the month grid; six rows fits every month layout. */
export const MONTH_GRID_DAYS = 42;

export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export type MonthGridDay<T extends CalendarEventLike = CalendarEventLike> = {
  key: string;
  date: Date;
  dayOfMonth: number;
  inMonth: boolean;
  isToday: boolean;
  events: T[];
};

function dayKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${m}-${d}`;
}

/** First of the month at local midnight. */
export function startOfMonth(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

export function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

/** Sunday on or before the 1st of the anchor's month, at local midnight. */
export function monthGridStart(anchor: Date): Date {
  const first = startOfMonth(anchor);
  return addDays(first, -first.getDay());
}

/** Fetch window covering every cell of the month grid. */
export function monthGridRange(anchor: Date): { timeMin: string; timeMax: string } {
  const start = monthGridStart(anchor);
  return {
    timeMin: start.toISOString(),
    timeMax: addDays(start, MONTH_GRID_DAYS).toISOString(),
  };
}

export function monthLabel(anchor: Date): string {
  return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

/**
 * Local-midnight days an event covers. All-day ends are exclusive per the
 * Google Calendar API; timed events ending exactly at midnight do not spill
 * into the next day.
 */
function eventDayBounds(event: CalendarEventLike): { first: Date; last: Date } | null {
  if (event.start?.date) {
    const first = new Date(`${event.start.date}T00:00:00`);
    if (Number.isNaN(first.getTime())) return null;
    const endRaw = event.end?.date ? new Date(`${event.end.date}T00:00:00`) : null;
    const last =
      endRaw && !Number.isNaN(endRaw.getTime()) && endRaw > first ? addDays(endRaw, -1) : first;
    return { first, last };
  }
  if (!event.start?.dateTime) return null;
  const start = new Date(event.start.dateTime);
  if (Number.isNaN(start.getTime())) return null;
  const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!end || Number.isNaN(end.getTime()) || end <= start) return { first, last: first };
  const endInclusive = new Date(end.getTime() - 1);
  const last = new Date(
    endInclusive.getFullYear(),
    endInclusive.getMonth(),
    endInclusive.getDate(),
  );
  return { first, last: last < first ? first : last };
}

/** 42 day cells for the month containing `anchor`, each with its events in start order. */
export function buildMonthGrid<T extends CalendarEventLike>(
  anchor: Date,
  events: T[] = [],
  today: Date = new Date(),
): MonthGridDay<T>[] {
  const start = monthGridStart(anchor);
  const month = anchor.getMonth();
  const todayKey = dayKey(today);
  const days: MonthGridDay<T>[] = [];
  const byKey = new Map<string, MonthGridDay<T>>();
  for (let i = 0; i < MONTH_GRID_DAYS; i += 1) {
    const date = addDays(start, i);
    const key = dayKey(date);
    const day: MonthGridDay<T> = {
      key,
      date,
      dayOfMonth: date.getDate(),
      inMonth: date.getMonth() === month,
      isToday: key === todayKey,
      events: [],
    };
    days.push(day);
    byKey.set(key, day);
  }
  for (const event of sortCalendarEvents(events)) {
    const bounds = eventDayBounds(event);
    if (!bounds) continue;
    // Clamp to the grid so a months-long event doesn't loop far outside it.
    let cursor = bounds.first < start ? new Date(start) : bounds.first;
    const gridEnd = days[days.length - 1].date;
    const last = bounds.last > gridEnd ? gridEnd : bounds.last;
    while (cursor <= last) {
      byKey.get(dayKey(cursor))?.events.push(event);
      cursor = addDays(cursor, 1);
    }
  }
  return days;
}

/** Compact start time for a grid chip; empty for all-day events. */
export function eventChipTime(event: CalendarEventLike): string {
  if (event.start?.date || !event.start?.dateTime) return '';
  const start = new Date(event.start.dateTime);
  if (Number.isNaN(start.getTime())) return '';
  return start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Calendar page layouts: the month grid, or a list of one week or one day. */
export type CalendarViewMode = 'month' | 'week' | 'day';

export const CALENDAR_VIEW_MODES: readonly CalendarViewMode[] = ['month', 'week', 'day'];

export const CALENDAR_VIEW_KEY = 'agent-hub.calendar.view';

export const CALENDAR_VIEW_LABELS: Record<CalendarViewMode, string> = {
  month: 'Month',
  week: 'Week',
  day: 'Day',
};

/** Stored view, falling back to the month grid for anything unrecognized. */
export function parseCalendarView(raw: string | null | undefined): CalendarViewMode {
  return CALENDAR_VIEW_MODES.includes(raw as CalendarViewMode)
    ? (raw as CalendarViewMode)
    : 'month';
}

export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Sunday on or before `date`, at local midnight, matching the month grid's rows. */
export function startOfWeek(date: Date): Date {
  const day = startOfDay(date);
  return addDays(day, -day.getDay());
}

/** First local midnight of the week or day containing `anchor`. */
export function listPeriodStart(mode: 'week' | 'day', anchor: Date): Date {
  return mode === 'week' ? startOfWeek(anchor) : startOfDay(anchor);
}

/** Fetch window for the week or day list containing `anchor`. */
export function listViewRange(
  mode: 'week' | 'day',
  anchor: Date,
): { timeMin: string; timeMax: string } {
  const start = listPeriodStart(mode, anchor);
  // setDate keeps local midnight across a DST change, unlike adding milliseconds.
  return {
    timeMin: start.toISOString(),
    timeMax: addDays(start, mode === 'week' ? 7 : 1).toISOString(),
  };
}

/** The anchor moved one week or day forward (`delta` 1) or back (`delta` -1). */
export function shiftListAnchor(mode: 'week' | 'day', anchor: Date, delta: number): Date {
  return addDays(listPeriodStart(mode, anchor), (mode === 'week' ? 7 : 1) * delta);
}

/** Heading for the list: "Oct 25 to Oct 31, 2026" for a week, "Friday, October 30, 2026" for a day. */
export function listViewLabel(mode: 'week' | 'day', anchor: Date): string {
  const start = listPeriodStart(mode, anchor);
  if (mode === 'day') {
    return start.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  }
  const end = addDays(start, 6);
  const short = { month: 'short', day: 'numeric' } as const;
  return `${start.toLocaleDateString(undefined, short)} to ${end.toLocaleDateString(undefined, {
    ...short,
    year: 'numeric',
  })}`;
}
