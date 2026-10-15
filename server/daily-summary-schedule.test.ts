/**
 * Hub Daily Summary schedule: normalization, and the once-a-minute tick that
 * converts schedules into digests before running due digests.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeDailySummaryTimes,
  normalizeDailySummarySchedule,
  runDailySummaryScheduleTick,
  MAX_DAILY_SUMMARY_TIMES,
} from './daily-summary-schedule.js';

describe('normalizeDailySummaryTimes', () => {
  it('keeps valid HH:MM, drops invalid, de-dupes and sorts', () => {
    expect(normalizeDailySummaryTimes(['09:00', '07:30', '09:00', '24:00', 'x', '23:59'])).toEqual([
      '07:30',
      '09:00',
      '23:59',
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeDailySummaryTimes('09:00')).toEqual([]);
    expect(normalizeDailySummaryTimes(null)).toEqual([]);
  });

  it('caps the number of times', () => {
    const many = Array.from({ length: 30 }, (_, i) => `${String(i % 24).padStart(2, '0')}:00`);
    expect(normalizeDailySummaryTimes(many).length).toBeLessThanOrEqual(MAX_DAILY_SUMMARY_TIMES);
  });
});

describe('normalizeDailySummarySchedule', () => {
  it('defaults an invalid timezone to UTC and reads enabled strictly', () => {
    expect(
      normalizeDailySummarySchedule({ enabled: 'yes', timeZone: 'Nope/Zone', times: ['08:00'] }),
    ).toEqual({ enabled: false, timeZone: 'UTC', times: ['08:00'] });
  });

  it('returns undefined when no valid times remain', () => {
    expect(normalizeDailySummarySchedule({ enabled: true, times: ['nope'] })).toBeUndefined();
    expect(normalizeDailySummarySchedule({ enabled: true, times: [] })).toBeUndefined();
    expect(normalizeDailySummarySchedule(null)).toBeUndefined();
  });
});

describe('runDailySummaryScheduleTick', () => {
  it('converts schedules before running digests, so a converted schedule can run this minute', async () => {
    const order: string[] = [];
    const now = new Date('2026-08-21T08:00:10.000Z');
    let seen: Date | null = null;
    await runDailySummaryScheduleTick({
      migrateSchedules: () => order.push('migrate'),
      onTick: async (t) => {
        order.push('digests');
        seen = t;
      },
      now: () => now,
    });
    expect(order).toEqual(['migrate', 'digests']);
    expect(seen).toBe(now);
  });

  it('still runs digests when the conversion throws', async () => {
    let ran = false;
    await runDailySummaryScheduleTick({
      migrateSchedules: () => {
        throw new Error('db locked');
      },
      onTick: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
  });
});
