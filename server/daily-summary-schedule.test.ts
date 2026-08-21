/**
 * Hub Daily Summary auto-refresh schedule — pure selection, normalization, and
 * the once-a-minute tick (de-dup + per-user generation dispatch).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RouteDeps } from './types.js';
import type { HubDailySummaryStored } from './user-preferences-store.js';
import {
  normalizeDailySummaryTimes,
  normalizeDailySummarySchedule,
  selectDueDailySummaries,
  runDailySummaryScheduleTick,
  resetDailySummaryFiredGuard,
  MAX_DAILY_SUMMARY_TIMES,
  type HubDailySummarySchedule,
} from './daily-summary-schedule.js';

const report: HubDailySummaryStored = {
  date: '2026-08-21',
  timeZone: 'UTC',
  markdown: '## Today',
  engine: 'claude-code',
  model: 'x',
  generatedAt: '2026-08-21T08:00:00.000Z',
};

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

describe('selectDueDailySummaries', () => {
  const sched = (over: Partial<HubDailySummarySchedule>): HubDailySummarySchedule => ({
    enabled: true,
    timeZone: 'UTC',
    times: ['08:00'],
    ...over,
  });

  it('fires exactly when the local HH:MM matches', () => {
    const now = new Date('2026-08-21T08:00:30.000Z');
    const due = selectDueDailySummaries(now, [{ userId: 'u1', schedule: sched({}) }]);
    expect(due).toEqual([
      { userId: 'u1', time: '08:00', localDate: '2026-08-21', timeZone: 'UTC' },
    ]);
  });

  it('does not fire off-minute', () => {
    const now = new Date('2026-08-21T08:01:00.000Z');
    expect(selectDueDailySummaries(now, [{ userId: 'u1', schedule: sched({}) }])).toEqual([]);
  });

  it('skips disabled schedules', () => {
    const now = new Date('2026-08-21T08:00:00.000Z');
    expect(
      selectDueDailySummaries(now, [{ userId: 'u1', schedule: sched({ enabled: false }) }]),
    ).toEqual([]);
  });

  it('resolves the time in the user timezone, not UTC', () => {
    // 12:00 UTC is 08:00 in America/New_York (EDT, UTC-4) on this date.
    const now = new Date('2026-08-21T12:00:00.000Z');
    const due = selectDueDailySummaries(now, [
      { userId: 'ny', schedule: sched({ timeZone: 'America/New_York' }) },
    ]);
    expect(due).toEqual([
      { userId: 'ny', time: '08:00', localDate: '2026-08-21', timeZone: 'America/New_York' },
    ]);
  });
});

describe('runDailySummaryScheduleTick', () => {
  beforeEach(() => resetDailySummaryFiredGuard());

  const deps = (
    schedules: Array<{ userId: string; schedule: HubDailySummarySchedule }>,
    generate: ReturnType<typeof vi.fn>,
    now: Date,
  ) => ({
    routeDeps: {} as RouteDeps,
    listSchedules: () => schedules,
    generate: generate as unknown as (input: unknown) => Promise<HubDailySummaryStored>,
    now: () => now,
  });

  it('generates once per due user and passes their timezone', async () => {
    const generate = vi.fn(async () => report);
    const now = new Date('2026-08-21T08:00:10.000Z');
    await runDailySummaryScheduleTick(
      deps(
        [{ userId: 'u1', schedule: { enabled: true, timeZone: 'UTC', times: ['08:00'] } }],
        generate,
        now,
      ),
    );
    expect(generate).toHaveBeenCalledTimes(1);
    const firstArg = (generate.mock.calls[0] as unknown[])[0];
    expect(firstArg).toMatchObject({ userId: 'u1', timeZone: 'UTC' });
  });

  it('does not re-fire the same user/time within a tick or a repeated tick', async () => {
    const generate = vi.fn(async () => report);
    const now = new Date('2026-08-21T08:00:10.000Z');
    const d = deps(
      [{ userId: 'u1', schedule: { enabled: true, timeZone: 'UTC', times: ['08:00'] } }],
      generate,
      now,
    );
    await runDailySummaryScheduleTick(d);
    await runDailySummaryScheduleTick(d);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("one user's failure does not block another", async () => {
    const generate = vi
      .fn()
      .mockRejectedValueOnce(new Error('no creds'))
      .mockResolvedValueOnce(report);
    const now = new Date('2026-08-21T08:00:10.000Z');
    await runDailySummaryScheduleTick(
      deps(
        [
          { userId: 'boom', schedule: { enabled: true, timeZone: 'UTC', times: ['08:00'] } },
          { userId: 'ok', schedule: { enabled: true, timeZone: 'UTC', times: ['08:00'] } },
        ],
        generate,
        now,
      ),
    );
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
