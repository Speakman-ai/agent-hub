import { describe, it, expect } from 'vitest';
import {
  buildSecurityScanPatch,
  isSecurityScanSchedule,
  nextScheduleConfig,
  readSecurityScheduleConfig,
  SECURITY_SCHEDULE_OPTIONS,
} from './securitySchedule';

describe('mobile isSecurityScanSchedule', () => {
  it('accepts the three server-supported values, rejects others', () => {
    expect(isSecurityScanSchedule('daily')).toBe(true);
    expect(isSecurityScanSchedule('weekly')).toBe(true);
    expect(isSecurityScanSchedule('off')).toBe(true);
    for (const bad of ['', 'monthly', null, undefined, 3]) {
      expect(isSecurityScanSchedule(bad)).toBe(false);
    }
  });
});

describe('mobile readSecurityScheduleConfig', () => {
  it('reads an explicit schedule + onPush', () => {
    expect(
      readSecurityScheduleConfig({ securityScan: { schedule: 'daily', onPush: true } }),
    ).toEqual({ schedule: 'daily', onPush: true });
  });

  it('defaults unset/unknown to placeholder + onPush false', () => {
    expect(readSecurityScheduleConfig({})).toEqual({ schedule: '', onPush: false });
    expect(readSecurityScheduleConfig(null)).toEqual({ schedule: '', onPush: false });
    expect(readSecurityScheduleConfig({ securityScan: { schedule: 'monthly' } })).toEqual({
      schedule: '',
      onPush: false,
    });
  });

  it('only a strict boolean true enables onPush', () => {
    expect(readSecurityScheduleConfig({ securityScan: { onPush: 'yes' } }).onPush).toBe(false);
    expect(readSecurityScheduleConfig({ securityScan: { onPush: true } }).onPush).toBe(true);
  });
});

describe('mobile SECURITY_SCHEDULE_OPTIONS', () => {
  it('offers exactly the three server-accepted cadences', () => {
    expect(SECURITY_SCHEDULE_OPTIONS.map((o) => o.value)).toEqual(['daily', 'weekly', 'off']);
  });
});

// The mobile SecurityScreen has no RN component-render harness (the mobile
// vitest env is `node`, with no @testing-library/react-native / react-test-
// renderer). These cover the non-trivial press/patch logic the screen delegates
// to the shared helpers — the same behaviour the web SecurityPage.test.tsx
// exercises through the DOM: which cadence change fires a PATCH, what body it
// sends, and that the unset placeholder is never written back.
describe('mobile buildSecurityScanPatch', () => {
  it('sends the full object when schedule is set (defensive vs wholesale replace)', () => {
    expect(buildSecurityScanPatch({ schedule: 'daily', onPush: true })).toEqual({
      schedule: 'daily',
      onPush: true,
    });
  });

  it('omits the schedule key when unset', () => {
    expect(buildSecurityScanPatch({ schedule: '', onPush: false })).toEqual({ onPush: false });
  });
});

describe('mobile nextScheduleConfig (schedule-press → next config or no-op)', () => {
  it('updates on a real change, preserving onPush', () => {
    expect(nextScheduleConfig({ schedule: 'weekly', onPush: true }, 'off')).toEqual({
      schedule: 'off',
      onPush: true,
    });
  });

  it('is a no-op when the pressed value is unchanged or invalid', () => {
    expect(nextScheduleConfig({ schedule: 'daily', onPush: false }, 'daily')).toBeNull();
    expect(nextScheduleConfig({ schedule: 'daily', onPush: false }, 'monthly')).toBeNull();
  });
});
