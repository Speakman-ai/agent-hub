import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_TIMEZONES,
  FIXED_OFFSET_TIMEZONES,
  isValidTimezone,
  listTimezones,
} from './timezones';

function mockSupportedValuesOf(impl: () => string[]) {
  return vi
    .spyOn(Intl as unknown as { supportedValuesOf: (key: string) => string[] }, 'supportedValuesOf')
    .mockImplementation(impl);
}

describe('listTimezones', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the runtime IANA zones, sorted and de-duplicated', () => {
    mockSupportedValuesOf(() => ['America/New_York', 'UTC', 'America/New_York', 'Europe/London']);

    const zones = listTimezones();
    // Sorted, de-duplicated, and a superset of the mocked base list.
    expect(zones).toEqual([...zones].sort((a, b) => a.localeCompare(b)));
    expect(new Set(zones).size).toBe(zones.length);
    expect(zones).toContain('America/New_York');
    expect(zones).toContain('Europe/London');
    // Every entry is a real IANA zone.
    expect(zones.every((z) => isValidTimezone(z))).toBe(true);
  });

  it('falls back to the full IANA snapshot when supportedValuesOf is unavailable', () => {
    mockSupportedValuesOf(() => {
      throw new Error('not supported');
    });

    const zones = listTimezones();
    expect(zones).toContain('UTC');
    expect(zones).toContain('America/New_York');
    // The fallback snapshot is fully represented (fixed-offset zones are added on
    // top, so the result is a superset, not an exact match).
    for (const zone of FALLBACK_TIMEZONES) expect(zones).toContain(zone);
  });

  it('keeps complete zone coverage in the fallback (no regression from the old free-text field)', () => {
    mockSupportedValuesOf(() => {
      throw new Error('not supported');
    });

    const zones = listTimezones();
    // Zones a short "common list" would have dropped but the free-text field
    // used to accept — these must remain selectable via the fallback.
    for (const zone of [
      'Pacific/Honolulu',
      'Australia/Perth',
      'Asia/Tokyo',
      'America/Argentina/Ushuaia',
      'Antarctica/Troll',
    ]) {
      expect(zones).toContain(zone);
      expect(isValidTimezone(zone)).toBe(true);
    }
    // The fallback is the real database, not a two-dozen-entry stub.
    expect(zones.length).toBeGreaterThan(300);
  });

  it('offers fixed-offset Etc/GMT zones on the runtime path (omitted by supportedValuesOf)', () => {
    // Emulate the review runtime: supportedValuesOf enumerates canonical zones
    // only, with no Etc/GMT±N entries.
    mockSupportedValuesOf(() => ['America/New_York', 'Europe/London', 'Etc/UTC']);

    const zones = listTimezones();
    for (const zone of ['Etc/GMT+5', 'Etc/GMT-3', 'Etc/GMT', 'UTC', 'Etc/UTC']) {
      expect(zones).toContain(zone);
    }
    // Sanity: these really are backend-acceptable zones, not junk we invented.
    expect(zones.every((z) => isValidTimezone(z))).toBe(true);
  });

  it('offers fixed-offset Etc/GMT zones on the fallback path too', () => {
    mockSupportedValuesOf(() => {
      throw new Error('not supported');
    });

    const zones = listTimezones();
    for (const zone of ['Etc/GMT+5', 'Etc/GMT-3', 'Etc/GMT+12', 'Etc/GMT-14']) {
      expect(zones).toContain(zone);
    }
  });

  it('supplements an empty runtime result with the fixed-offset family', () => {
    mockSupportedValuesOf(() => []);

    const zones = listTimezones();
    // Empty runtime → fallback snapshot, plus every valid fixed-offset zone.
    for (const zone of FIXED_OFFSET_TIMEZONES) {
      if (isValidTimezone(zone)) expect(zones).toContain(zone);
    }
    expect(zones.length).toBeGreaterThanOrEqual(FALLBACK_TIMEZONES.length);
  });

  it('produces a real, non-trivial zone list from the actual runtime', () => {
    // No mock: exercise the live Intl database available in the test runtime.
    const zones = listTimezones();
    expect(zones.length).toBeGreaterThan(1);
    expect(zones).toContain('UTC');
    // The live runtime also gains the fixed-offset zones it does not enumerate.
    expect(zones).toContain('Etc/GMT+5');
  });
});

describe('FIXED_OFFSET_TIMEZONES', () => {
  it('spans the tz-database fixed-offset range and is Intl-valid', () => {
    expect(FIXED_OFFSET_TIMEZONES).toContain('Etc/GMT-14');
    expect(FIXED_OFFSET_TIMEZONES).toContain('Etc/GMT+12');
    expect(FIXED_OFFSET_TIMEZONES).toContain('Etc/GMT');
    expect(FIXED_OFFSET_TIMEZONES).toContain('UTC');
    // Never enumerate a zone the backend would reject.
    expect(FIXED_OFFSET_TIMEZONES.every((z) => isValidTimezone(z))).toBe(true);
  });
});

describe('isValidTimezone', () => {
  it('accepts valid IANA zones', () => {
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('  Europe/London  ')).toBe(true);
    expect(isValidTimezone('Etc/GMT+5')).toBe(true);
  });

  it('rejects blank and bogus values', () => {
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('   ')).toBe(false);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});
