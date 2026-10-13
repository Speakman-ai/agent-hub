import { describe, it, expect } from 'vitest';
import {
  describePrEnvironmentLimits,
  formatShortDuration,
  prEnvironmentRowView,
  prEnvironmentLimitsNote,
} from './prEnvironmentSettings';

const NOW = Date.parse('2026-10-13T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const H = 3_600_000;

describe('prEnvironmentRowView', () => {
  it('a ready env shows its age and last hit and can be stopped', () => {
    expect(
      prEnvironmentRowView(
        {
          id: 'e',
          prNumber: 1,
          status: 'ready',
          createdAt: ago(3 * 24 * H),
          lastHitAt: ago(5 * 60_000),
        },
        NOW,
      ),
    ).toEqual({ statusLabel: 'ready', tone: 'ok', age: '3d', lastHit: '5m', canStop: true });
  });

  it('a sleeping env reads as asleep, was never hit, and has nothing to stop', () => {
    expect(
      prEnvironmentRowView(
        { id: 'e', prNumber: 1, status: 'stopped', stopReason: 'idle', createdAt: ago(2 * H) },
        NOW,
      ),
    ).toMatchObject({ statusLabel: 'asleep', lastHit: 'never', canStop: false });
  });

  it('an unconfirmed teardown can be stopped again', () => {
    expect(
      prEnvironmentRowView(
        { id: 'e', prNumber: 1, status: 'stopped', cleanupPending: true, createdAt: ago(0) },
        NOW,
      ),
    ).toMatchObject({ statusLabel: 'teardown pending', tone: 'error', canStop: true });
  });
});

describe('formatting', () => {
  it('formats short durations', () => {
    expect(formatShortDuration(10_000)).toBe('now');
    expect(formatShortDuration(90 * 60_000)).toBe('1h');
    expect(formatShortDuration(47 * H)).toBe('47h');
    expect(formatShortDuration(49 * H)).toBe('2d');
  });

  it('describes limits, including the off values', () => {
    expect(
      describePrEnvironmentLimits({ maxConcurrent: 5, idleTtlMinutes: 60, maxLifetimeDays: 14 }),
    ).toBe('at most 5 running, sleep after 60 min idle, stop after 14 days without a push.');
    expect(
      describePrEnvironmentLimits({ maxConcurrent: 0, idleTtlMinutes: 0, maxLifetimeDays: 0 }),
    ).toBe('no cap, never sleep when idle, no max lifetime.');
  });
});

describe('prEnvironmentLimitsNote', () => {
  const limits = { maxConcurrent: 5, idleTtlMinutes: 60, maxLifetimeDays: 14 };
  it('promises a wake only when requests can wake an environment', () => {
    expect(prEnvironmentLimitsNote({ limits, wakeOnRequest: true })).toContain('starts it again');
    const off = prEnvironmentLimitsNote({
      limits,
      enforced: { ...limits, idleTtlMinutes: 0 },
      wakeOnRequest: false,
    });
    expect(off).toContain('never sleep when idle');
    expect(off).toContain('Idle sleep is off');
  });
});
