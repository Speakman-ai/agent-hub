import { describe, it, expect } from 'vitest';
import {
  toLocalDateTimeValue,
  parseLocalDateTimeValue,
  defaultScheduleDate,
  isFutureLocalDateTime,
  formatScheduledAutoMerge,
  deviceTimeZone,
} from './autoMergeSchedule';

describe('autoMergeSchedule', () => {
  it('round-trips a local wall-clock value', () => {
    const d = new Date(2026, 9, 13, 9, 5);
    expect(toLocalDateTimeValue(d)).toBe('2026-10-13T09:05');
    expect(parseLocalDateTimeValue('2026-10-13T09:05')?.getTime()).toBe(d.getTime());
    expect(parseLocalDateTimeValue('tomorrow')).toBeNull();
  });

  it('defaults to the top of an hour at least 15 minutes ahead', () => {
    expect(toLocalDateTimeValue(defaultScheduleDate(new Date(2026, 9, 13, 9, 50)))).toBe(
      '2026-10-13T11:00',
    );
    expect(toLocalDateTimeValue(defaultScheduleDate(new Date(2026, 9, 13, 9, 10)))).toBe(
      '2026-10-13T10:00',
    );
  });

  it('rejects past or malformed picks', () => {
    const now = new Date(2026, 9, 13, 9, 0);
    expect(isFutureLocalDateTime('2026-10-13T09:01', now)).toBe(true);
    expect(isFutureLocalDateTime('2026-10-13T09:00', now)).toBe(false);
    expect(isFutureLocalDateTime('', now)).toBe(false);
  });

  it('formats a stored UTC instant and tolerates missing values', () => {
    expect(formatScheduledAutoMerge(null)).toBeNull();
    expect(formatScheduledAutoMerge('nope')).toBeNull();
    expect(formatScheduledAutoMerge('2026-10-13T14:30:00.000Z')).toMatch(/Oct/);
    expect(deviceTimeZone()).toBeTruthy();
  });
});
