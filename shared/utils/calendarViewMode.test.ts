import { describe, expect, it } from 'vitest';
import {
  listViewLabel,
  listViewRange,
  parseCalendarView,
  shiftListAnchor,
  startOfWeek,
} from './calendarEvents';

describe('calendar view mode', () => {
  it('defaults to the month grid for missing or unknown values', () => {
    expect(parseCalendarView(null)).toBe('month');
    expect(parseCalendarView('agenda')).toBe('month');
    expect(parseCalendarView('week')).toBe('week');
    expect(parseCalendarView('day')).toBe('day');
  });

  it('starts weeks on Sunday at local midnight', () => {
    // Friday Oct 30 2026
    expect(startOfWeek(new Date(2026, 9, 30, 15, 45)).getTime()).toBe(
      new Date(2026, 9, 25).getTime(),
    );
    // A Sunday is its own week start.
    expect(startOfWeek(new Date(2026, 9, 25, 8)).getTime()).toBe(new Date(2026, 9, 25).getTime());
  });

  it('covers Sunday through Saturday for a week and one day for a day', () => {
    const anchor = new Date(2026, 9, 30, 15, 45);
    const week = listViewRange('week', anchor);
    expect(new Date(week.timeMin).getTime()).toBe(new Date(2026, 9, 25).getTime());
    expect(new Date(week.timeMax).getTime()).toBe(new Date(2026, 10, 1).getTime());
    const day = listViewRange('day', anchor);
    expect(new Date(day.timeMin).getTime()).toBe(new Date(2026, 9, 30).getTime());
    expect(new Date(day.timeMax).getTime()).toBe(new Date(2026, 9, 31).getTime());
  });

  it('steps a week or a day at a time', () => {
    const anchor = new Date(2026, 9, 30, 15, 45);
    expect(shiftListAnchor('week', anchor, 1).getTime()).toBe(new Date(2026, 10, 1).getTime());
    expect(shiftListAnchor('week', anchor, -1).getTime()).toBe(new Date(2026, 9, 18).getTime());
    expect(shiftListAnchor('day', anchor, 1).getTime()).toBe(new Date(2026, 9, 31).getTime());
    expect(shiftListAnchor('day', anchor, -1).getTime()).toBe(new Date(2026, 9, 29).getTime());
  });

  it('labels a week by its first and last day', () => {
    const label = listViewLabel('week', new Date(2026, 9, 30));
    expect(label).toContain(' to ');
    expect(label).toContain('2026');
  });
});
