import { describe, it, expect } from 'vitest';
import {
  TIME_RANGES,
  DEFAULT_RANGE_ID,
  rangeMsFor,
  TEXT_FACETS,
  COUNT_FACETS,
  buildRumSessionParams,
  sameFilters,
  hasActiveFilters,
  visibleReplayLinkFilters,
  REPLAY_LINK_FILTERS,
} from './rumSessionFilters';

describe('rangeMsFor', () => {
  it('resolves a preset id to its lookback window', () => {
    expect(rangeMsFor('15m')).toBe(15 * 60_000);
    expect(rangeMsFor('1d')).toBe(24 * 60 * 60_000);
  });
  it('returns null for the all-time preset and unknown ids', () => {
    expect(rangeMsFor('all')).toBeNull();
    expect(rangeMsFor('nonsense')).toBeNull();
  });
  it('defaults to the 24-hour window', () => {
    expect(DEFAULT_RANGE_ID).toBe('1d');
    expect(TIME_RANGES.find((r) => r.id === DEFAULT_RANGE_ID)?.ms).toBe(24 * 60 * 60_000);
  });
});

describe('buildRumSessionParams', () => {
  const now = 1_000_000_000_000;

  it('always carries limit and offset', () => {
    const p = buildRumSessionParams({}, null, now, 50, 100);
    expect(p).toMatchObject({ limit: 50, offset: 100 });
  });

  it('includes trimmed non-blank text facets and drops blanks', () => {
    const p = buildRumSessionParams(
      { usrEmail: '  ada@x.io ', browser: '', os: 'macOS' },
      null,
      now,
      50,
      0,
    );
    expect(p.usrEmail).toBe('ada@x.io');
    expect(p.os).toBe('macOS');
    expect(p).not.toHaveProperty('browser');
  });

  it('floors non-negative integers for count facets', () => {
    const p = buildRumSessionParams({ viewCountMin: '3.9', errorCountMin: '-2' }, null, now, 50, 0);
    expect(p.viewCountMin).toBe(3);
    expect(p.errorCountMin).toBe(0);
  });

  it('converts duration seconds inputs to ms', () => {
    const p = buildRumSessionParams({ durationMinS: '5', durationMaxS: '30' }, null, now, 50, 0);
    expect(p.durationMinMs).toBe(5000);
    expect(p.durationMaxMs).toBe(30000);
  });

  it('adds a from-bound when the range is bounded and omits it for all-time', () => {
    const bounded = buildRumSessionParams({}, 60_000, now, 50, 0);
    expect(bounded.from).toBe(now - 60_000);
    const unbounded = buildRumSessionParams({}, null, now, 50, 0);
    expect(unbounded).not.toHaveProperty('from');
  });
});

describe('sameFilters', () => {
  it('treats blank/missing keys as equal', () => {
    expect(sameFilters({}, { usrEmail: '' })).toBe(true);
    expect(sameFilters({ browser: '  ' }, {})).toBe(true);
  });
  it('trims before comparing values', () => {
    expect(sameFilters({ os: 'macOS' }, { os: ' macOS ' })).toBe(true);
  });
  it('detects a real change', () => {
    expect(sameFilters({ os: 'macOS' }, { os: 'Windows' })).toBe(false);
    expect(sameFilters({}, { browser: 'Chrome' })).toBe(false);
  });
});

describe('hasActiveFilters', () => {
  it('is false when every value is blank', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ usrEmail: '', os: '  ' })).toBe(false);
  });
  it('is true with any effective value', () => {
    expect(hasActiveFilters({ browser: 'Chrome' })).toBe(true);
  });
});

describe('facet definitions stay in lockstep with web', () => {
  it('exposes the Datadog text + count facets', () => {
    expect(TEXT_FACETS.map((f) => f.key)).toEqual([
      'usrEmail',
      'usrName',
      'usrId',
      'deviceType',
      'browser',
      'os',
      'geoCountry',
    ]);
    expect(COUNT_FACETS.map((f) => f.key)).toEqual([
      'viewCountMin',
      'actionCountMin',
      'errorCountMin',
      'frustrationCountMin',
    ]);
  });
});

describe('visibleReplayLinkFilters', () => {
  it('hides the orphans filter without privilege', () => {
    expect(visibleReplayLinkFilters(false).map((f) => f.id)).toEqual(['all', 'linked', 'unlinked']);
  });
  it('shows all filters (incl. orphans) for privileged callers', () => {
    expect(visibleReplayLinkFilters(true).map((f) => f.id)).toEqual(
      REPLAY_LINK_FILTERS.map((f) => f.id),
    );
  });
});
