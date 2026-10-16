import { describe, expect, it } from 'vitest';
import { nextAppVersion, parseVersion } from './next-app-version.mjs';

describe('nextAppVersion', () => {
  it('bumps the patch of app.json when EAS has no builds yet', () => {
    expect(nextAppVersion('1.0.0', [])).toBe('1.0.1');
  });

  it('bumps past the highest version EAS has already built', () => {
    const builds = [{ appVersion: '1.0.4' }, { appVersion: '1.0.9' }, { appVersion: '1.0.10' }];
    expect(nextAppVersion('1.0.0', builds)).toBe('1.0.11');
  });

  it('treats app.json as a floor so a manual minor bump wins', () => {
    expect(nextAppVersion('1.1.0', [{ appVersion: '1.0.12' }])).toBe('1.1.1');
  });

  it('gives consecutive builds strictly increasing versions', () => {
    // Each deploy starts from a fresh checkout, so app.json never carries the
    // previous bump; only EAS's build history does.
    const builds = [];
    const seen = [];
    for (let i = 0; i < 3; i += 1) {
      const next = nextAppVersion('1.0.0', builds);
      seen.push(next);
      builds.unshift({ appVersion: next });
    }
    expect(seen).toEqual(['1.0.1', '1.0.2', '1.0.3']);
  });

  it('ignores builds without a usable version', () => {
    const builds = [{ appVersion: null }, {}, null, { appVersion: 'abc' }, { appVersion: '2' }];
    expect(nextAppVersion('1.0.0', builds)).toBe('2.0.1');
  });

  it('rejects a malformed app.json version', () => {
    expect(() => nextAppVersion('one', [])).toThrow(/not a MAJOR.MINOR.PATCH/);
  });
});

describe('parseVersion', () => {
  it('pads short versions', () => {
    expect(parseVersion('1.2')).toEqual([1, 2, 0]);
    expect(parseVersion('1.2.3-beta')).toBeNull();
  });
});
