import { describe, expect, it } from 'vitest';
import { defaultCalendarRange, eventTimeLabel, sortCalendarEvents } from './calendarEvents';

function localDateKey(date: Date) {
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
}

describe('calendarEvents helpers', () => {
  it('builds a seven-local-day range on local midnight boundaries', () => {
    const now = new Date('2026-03-07T15:30:00Z');
    const range = defaultCalendarRange(now);
    const start = new Date(range.timeMin);
    const end = new Date(range.timeMax);
    const expectedStart = new Date(now);
    expectedStart.setHours(0, 0, 0, 0);
    const expectedEnd = new Date(expectedStart);
    expectedEnd.setDate(expectedEnd.getDate() + 7);

    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(localDateKey(start)).toBe(localDateKey(expectedStart));
    expect(end.getHours()).toBe(0);
    expect(end.getMinutes()).toBe(0);
    expect(localDateKey(end)).toBe(localDateKey(expectedEnd));
  });

  it('sorts calendar events by start time', () => {
    const sorted = sortCalendarEvents([
      { id: 'late', start: { dateTime: '2026-07-03T12:00:00Z' } },
      { id: 'early', start: { dateTime: '2026-07-01T12:00:00Z' } },
    ]);

    expect(sorted.map((event) => event.id)).toEqual(['early', 'late']);
  });

  it('labels all-day events with their date', () => {
    expect(eventTimeLabel({ start: { date: '2026-07-01' } })).toMatch(/2026|7|Jul/);
  });
});
