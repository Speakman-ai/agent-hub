import { describe, it, expect } from 'vitest';
import { compareVersions, isValidVersion, parseVersion } from './version-compare.js';

describe('parseVersion / isValidVersion', () => {
  it('accepts plain and v-prefixed versions and rejects junk', () => {
    expect(isValidVersion('1.2.3')).toBe(true);
    expect(isValidVersion('v4.17.21')).toBe(true);
    expect(isValidVersion('1.0.0-rc.1')).toBe(true);
    expect(isValidVersion('1.2.3+build.7')).toBe(true);
    expect(isValidVersion('latest')).toBe(false);
    expect(isValidVersion('^1.2.3')).toBe(false);
    expect(parseVersion('1')).toEqual({ main: [1, 0, 0], prerelease: [] });
  });
});

describe('compareVersions', () => {
  it('orders by major.minor.patch numerically (not lexically)', () => {
    expect(compareVersions('4.17.9', '4.17.21')).toBe(-1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });

  it('ranks a prerelease below its release', () => {
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.2')).toBe(-1);
  });

  it('sorts a list ascending', () => {
    const sorted = ['4.17.21', '4.17.9', '4.17.12'].sort(compareVersions);
    expect(sorted).toEqual(['4.17.9', '4.17.12', '4.17.21']);
  });

  it('sorts unparseable versions last', () => {
    expect(compareVersions('garbage', '1.0.0')).toBe(1);
    expect(compareVersions('1.0.0', 'garbage')).toBe(-1);
  });
});
