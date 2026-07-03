import { describe, it, expect } from 'vitest';
import {
  buildSecurityScanPatch,
  isSecurityScanSchedule,
  nextScheduleConfig,
  readSecurityScheduleConfig,
  SECURITY_SCHEDULE_OPTIONS,
} from './securitySchedule';

describe('isSecurityScanSchedule', () => {
  it('accepts the three server-supported values', () => {
    expect(isSecurityScanSchedule('off')).toBe(true);
    expect(isSecurityScanSchedule('daily')).toBe(true);
    expect(isSecurityScanSchedule('weekly')).toBe(true);
  });

  it('rejects anything else', () => {
    for (const bad of ['', 'DAILY', 'monthly', null, undefined, 0, {}]) {
      expect(isSecurityScanSchedule(bad)).toBe(false);
    }
  });
});

describe('readSecurityScheduleConfig', () => {
  it('reads an explicit schedule + onPush', () => {
    expect(
      readSecurityScheduleConfig({ securityScan: { schedule: 'daily', onPush: true } }),
    ).toEqual({ schedule: 'daily', onPush: true });
  });

  it('treats an unset securityScan as default placeholder, onPush false', () => {
    expect(readSecurityScheduleConfig({})).toEqual({ schedule: '', onPush: false });
    expect(readSecurityScheduleConfig(null)).toEqual({ schedule: '', onPush: false });
    expect(readSecurityScheduleConfig(undefined)).toEqual({ schedule: '', onPush: false });
  });

  it('coerces an unrecognised schedule to the placeholder', () => {
    expect(readSecurityScheduleConfig({ securityScan: { schedule: 'monthly' } })).toEqual({
      schedule: '',
      onPush: false,
    });
  });

  it('coerces a truthy-but-not-true onPush to false', () => {
    // Only a strict boolean true enables the toggle.
    expect(readSecurityScheduleConfig({ securityScan: { onPush: 'yes' } }).onPush).toBe(false);
    expect(readSecurityScheduleConfig({ securityScan: { onPush: 1 } }).onPush).toBe(false);
  });

  it('reads schedule without onPush and vice versa', () => {
    expect(readSecurityScheduleConfig({ securityScan: { schedule: 'weekly' } })).toEqual({
      schedule: 'weekly',
      onPush: false,
    });
    expect(readSecurityScheduleConfig({ securityScan: { onPush: true } })).toEqual({
      schedule: '',
      onPush: true,
    });
  });
});

describe('SECURITY_SCHEDULE_OPTIONS', () => {
  it('offers exactly the three server-accepted cadences', () => {
    expect(SECURITY_SCHEDULE_OPTIONS.map((o) => o.value)).toEqual(['daily', 'weekly', 'off']);
    for (const opt of SECURITY_SCHEDULE_OPTIONS) {
      expect(isSecurityScanSchedule(opt.value)).toBe(true);
      expect(typeof opt.label).toBe('string');
    }
  });
});

describe('buildSecurityScanPatch', () => {
  it('sends the full object (schedule + onPush) when schedule is set', () => {
    expect(buildSecurityScanPatch({ schedule: 'daily', onPush: true })).toEqual({
      schedule: 'daily',
      onPush: true,
    });
    expect(buildSecurityScanPatch({ schedule: 'weekly', onPush: false })).toEqual({
      schedule: 'weekly',
      onPush: false,
    });
  });

  it('omits the schedule key when unset (server rejects "")', () => {
    const patch = buildSecurityScanPatch({ schedule: '', onPush: true });
    expect(patch).toEqual({ onPush: true });
    expect('schedule' in patch).toBe(false);
  });
});

describe('nextScheduleConfig', () => {
  it('returns the updated config for a real change', () => {
    expect(nextScheduleConfig({ schedule: 'weekly', onPush: true }, 'daily')).toEqual({
      schedule: 'daily',
      onPush: true,
    });
  });

  it('returns null for a no-op (unchanged value)', () => {
    expect(nextScheduleConfig({ schedule: 'daily', onPush: false }, 'daily')).toBeNull();
  });

  it('returns null for an invalid value (e.g. the placeholder)', () => {
    expect(nextScheduleConfig({ schedule: 'daily', onPush: false }, '')).toBeNull();
    expect(nextScheduleConfig({ schedule: 'daily', onPush: false }, 'monthly')).toBeNull();
  });

  it('preserves onPush when only the schedule changes', () => {
    expect(nextScheduleConfig({ schedule: '', onPush: true }, 'off')).toEqual({
      schedule: 'off',
      onPush: true,
    });
  });
});
