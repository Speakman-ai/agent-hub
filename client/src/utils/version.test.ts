import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  compareSemver,
  buildDmgDownloadUrl,
  buildLatestDmgDownloadUrl,
  RELEASE_BUCKET_ROOT,
  resolveReleaseBucketBase,
} from './version';

// Reference bucket a build opts into via VITE_RELEASE_BUCKET_BASE. The default
// (unset env) is empty so a self-hosted build points at no vendor bucket.
const BASE = 'https://releases.example.test';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveReleaseBucketBase', () => {
  it('is empty (no releases) when the env var is unset', () => {
    expect(resolveReleaseBucketBase({})).toBe('');
    expect(resolveReleaseBucketBase(null)).toBe('');
  });

  it('reads VITE_RELEASE_BUCKET_BASE and strips trailing slashes', () => {
    expect(resolveReleaseBucketBase({ VITE_RELEASE_BUCKET_BASE: `${BASE}/` })).toBe(BASE);
    expect(resolveReleaseBucketBase({ VITE_RELEASE_BUCKET_BASE: `  ${BASE}  ` })).toBe(BASE);
  });
});

describe('RELEASE_BUCKET_ROOT', () => {
  it('is empty by default (no release bucket configured at build time)', () => {
    expect(RELEASE_BUCKET_ROOT!).toBe('');
  });

  it('shares the same origin as buildDmgDownloadUrl output when configured', () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', BASE);
    const dmg = buildDmgDownloadUrl({ version: '1.4.2', platform: 'darwin', arch: 'arm64' });
    expect(dmg!.startsWith(`${BASE}/`)).toBe(true);
  });
});

describe('compareSemver', () => {
  const cases = [
    // equal
    ['1.2.3', '1.2.3', 0],
    ['v1.2.3', '1.2.3', 0],
    ['V1.2.3', 'v1.2.3', 0],
    ['1.2.3-beta.1', '1.2.3', 0], // prerelease stripped
    ['1.2.3+build.5', '1.2.3', 0], // build stripped
    // a < b
    ['1.2.3', '1.2.4', -1],
    ['1.2.3', '1.3.0', -1],
    ['1.2.3', '2.0.0', -1],
    ['1.2.9', '1.3.0', -1],
    ['0.9.0', '1.0.0', -1],
    // a > b
    ['1.2.4', '1.2.3', 1],
    ['1.3.0', '1.2.9', 1],
    ['2.0.0', '1.99.99', 1],
    // numeric (not lexicographic) compare
    ['1.2.10', '1.2.9', 1],
    ['1.10.0', '1.9.0', 1],
  ];

  for (const [a, b, expected] of cases) {
    it(`compareSemver(${JSON.stringify(a)}, ${JSON.stringify(b)}) === ${expected}`, () => {
      expect(compareSemver(a, b)).toBe(expected);
    });
  }

  describe('invalid inputs return 0 (treat as equal)', () => {
    const invalid = [null, undefined, '', '   ', 'not-a-version', '1', '1.2', 'a.b.c', 42, {}];
    for (const bad of invalid) {
      it(`compareSemver(${JSON.stringify(bad)}, '1.2.3') === 0`, () => {
        expect(compareSemver(bad, '1.2.3')).toBe(0);
      });
      it(`compareSemver('1.2.3', ${JSON.stringify(bad)}) === 0`, () => {
        expect(compareSemver('1.2.3', bad)).toBe(0);
      });
    }
  });
});

describe('buildDmgDownloadUrl', () => {
  it('returns null when no release bucket is configured (self-hosted default)', () => {
    // env unstubbed → VITE_RELEASE_BUCKET_BASE unset
    expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'darwin', arch: 'arm64' })).toBeNull();
  });

  describe('with a configured release bucket', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_RELEASE_BUCKET_BASE', BASE);
    });

    it('returns the arm64 URL on darwin + arm64', () => {
      expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'darwin', arch: 'arm64' })).toBe(
        `${BASE}/v1.4.2/Agent%20Hub-1.4.2-arm64.dmg`,
      );
    });

    it('returns the x64 URL on darwin + x64', () => {
      expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'darwin', arch: 'x64' })).toBe(
        `${BASE}/v1.4.2/Agent%20Hub-1.4.2.dmg`,
      );
    });

    it('falls back to x64 URL when arch is undefined on darwin', () => {
      expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'darwin' })).toBe(
        `${BASE}/v1.4.2/Agent%20Hub-1.4.2.dmg`,
      );
    });

    it('strips a leading v prefix from the version', () => {
      expect(buildDmgDownloadUrl({ version: 'v1.4.2', platform: 'darwin', arch: 'arm64' })).toBe(
        `${BASE}/v1.4.2/Agent%20Hub-1.4.2-arm64.dmg`,
      );
    });
  });

  it('returns null on non-darwin platforms (we only publish DMGs today)', () => {
    expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'win32', arch: 'x64' })).toBeNull();
    expect(buildDmgDownloadUrl({ version: '1.4.2', platform: 'linux', arch: 'x64' })).toBeNull();
    expect(
      buildDmgDownloadUrl({ version: '1.4.2', platform: undefined, arch: 'arm64' }),
    ).toBeNull();
  });

  it('returns null for missing / empty version', () => {
    expect(buildDmgDownloadUrl({ platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(buildDmgDownloadUrl({ version: '', platform: 'darwin', arch: 'arm64' })).toBeNull();
    expect(buildDmgDownloadUrl({ version: '   ', platform: 'darwin', arch: 'arm64' })).toBeNull();
  });

  it('handles a completely empty argument object without throwing', () => {
    expect(buildDmgDownloadUrl({})).toBeNull();
    expect(buildDmgDownloadUrl()).toBeNull();
  });
});

describe('buildLatestDmgDownloadUrl', () => {
  it('builds a direct x64 DMG URL from the current web bundle version', () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', BASE);
    vi.stubEnv('VITE_APP_VERSION', '2.31.41');

    expect(buildLatestDmgDownloadUrl()).toBe(`${BASE}/v2.31.41/Agent%20Hub-2.31.41.dmg`);
  });

  it('returns null when the web bundle has no release version', () => {
    vi.stubEnv('VITE_RELEASE_BUCKET_BASE', BASE);

    expect(buildLatestDmgDownloadUrl()).toBeNull();
  });
});
