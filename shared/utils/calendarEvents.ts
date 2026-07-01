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
