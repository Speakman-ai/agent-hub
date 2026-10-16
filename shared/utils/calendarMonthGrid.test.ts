import { describe, expect, it } from 'vitest';
import {
  addMonths,
  buildMonthGrid,
  eventChipTime,
  MONTH_GRID_DAYS,
  monthGridRange,
  monthGridStart,
} from './calendarEvents';

const local = (y: number, m: number, d: number, h = 0, min = 0) =>
  new Date(y, m - 1, d, h, min).toISOString();

describe('month grid', () => {
  it('starts on the Sunday on or before the 1st and spans six weeks', () => {
    // October 2026 starts on a Thursday.
    const anchor = new Date(2026, 9, 16);
    const start = monthGridStart(anchor);
    expect(start.getDay()).toBe(0);
    expect([start.getMonth(), start.getDate()]).toEqual([8, 27]);
    const range = monthGridRange(anchor);
    expect(new Date(range.timeMin).getTime()).toBe(start.getTime());
    expect(new Date(range.timeMax).getTime()).toBe(new Date(2026, 10, 8).getTime());

    const grid = buildMonthGrid(anchor, [], new Date(2026, 9, 16, 12));
    expect(grid).toHaveLength(MONTH_GRID_DAYS);
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
    expect(grid.filter((d) => d.isToday).map((d) => d.key)).toEqual(['2026-10-16']);
  });

  it('places timed events on their local day in start order', () => {
    const grid = buildMonthGrid(new Date(2026, 9, 1), [
      { id: 'b', summary: 'Late', start: { dateTime: local(2026, 10, 5, 15) } },
      { id: 'a', summary: 'Early', start: { dateTime: local(2026, 10, 5, 9) } },
    ]);
    const day = grid.find((d) => d.key === '2026-10-05');
    expect(day?.events.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('spans multi-day all-day events with an exclusive end date', () => {
    const grid = buildMonthGrid(new Date(2026, 9, 1), [
      { id: 'trip', start: { date: '2026-10-10' }, end: { date: '2026-10-13' } },
    ]);
    const keys = grid.filter((d) => d.events.length).map((d) => d.key);
    expect(keys).toEqual(['2026-10-10', '2026-10-11', '2026-10-12']);
  });

  it('does not spill a timed event ending at midnight into the next day', () => {
    const grid = buildMonthGrid(new Date(2026, 9, 1), [
      {
        id: 'eve',
        start: { dateTime: local(2026, 10, 20, 22) },
        end: { dateTime: local(2026, 10, 21, 0) },
      },
    ]);
    expect(grid.filter((d) => d.events.length).map((d) => d.key)).toEqual(['2026-10-20']);
  });

  it('clamps events that run past the grid edges', () => {
    const grid = buildMonthGrid(new Date(2026, 9, 1), [
      { id: 'long', start: { date: '2026-09-01' }, end: { date: '2027-01-01' } },
    ]);
    expect(grid.every((d) => d.events.length === 1)).toBe(true);
  });

  it('moves between months from any day without skipping short months', () => {
    expect(addMonths(new Date(2026, 0, 31), 1).getMonth()).toBe(1);
  });

  it('formats chip times only for timed events', () => {
    expect(eventChipTime({ start: { date: '2026-10-10' } })).toBe('');
    expect(eventChipTime({ start: { dateTime: local(2026, 10, 10, 9, 30) } })).toMatch(/9:30/);
  });
});
