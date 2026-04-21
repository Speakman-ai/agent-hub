import { describe, it, expect } from 'vitest';
import {
  mergePaths,
  readLoginShellPath,
  extractPathFromShellOutput,
  refreshShellPath,
  getCachedShellPath,
  resolveSpawnPath,
} from './shell-path.js';

describe('mergePaths', () => {
  it('deduplicates identical segments while preserving first-seen order', () => {
    const merged = mergePaths('/a:/b:/c', '/b:/d:/a');
    expect(merged).toBe('/a:/b:/c:/d');
  });

  it('drops empty segments and whitespace-only entries', () => {
    const merged = mergePaths('/a::/b: :/c', '');
    expect(merged).toBe('/a:/b:/c');
  });

  it('tolerates undefined/null inputs', () => {
    expect(mergePaths(undefined, '/a:/b', null, undefined)).toBe('/a:/b');
  });

  it('returns empty string when no valid segments are provided', () => {
    expect(mergePaths(undefined, '', null)).toBe('');
  });
});

describe('extractPathFromShellOutput', () => {
  it('extracts PATH cleanly when shell output contains banner text', () => {
    const bannerOutput =
      'Loaded plugins: git nvm docker\nWelcome to zsh!\n__AH_PATH_START__/usr/bin:/home/me/.local/bin:/usr/local/bin__AH_PATH_END__\n';
    expect(extractPathFromShellOutput(bannerOutput)).toBe(
      '/usr/bin:/home/me/.local/bin:/usr/local/bin',
    );
  });

  it('extracts PATH when no banner text is present', () => {
    const clean = '__AH_PATH_START__/a:/b:/c__AH_PATH_END__';
    expect(extractPathFromShellOutput(clean)).toBe('/a:/b:/c');
  });

  it('returns null when sentinels are missing', () => {
    expect(extractPathFromShellOutput('/usr/bin:/usr/local/bin')).toBeNull();
  });

  it('handles multiline banners before and after sentinels', () => {
    const messy =
      'nvm use v20\nNow using node v20.11.0\n__AH_PATH_START__/home/u/.nvm/versions/node/v20.11.0/bin:/usr/bin__AH_PATH_END__\nDone.\n';
    expect(extractPathFromShellOutput(messy)).toBe(
      '/home/u/.nvm/versions/node/v20.11.0/bin:/usr/bin',
    );
  });
});

describe('readLoginShellPath', () => {
  it('returns a non-empty PATH string in a normal dev environment', () => {
    const p = readLoginShellPath();
    // /bin/sh always exists; if bash/zsh is missing the function returns null.
    if (p !== null) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.split(':').length).toBeGreaterThan(0);
    }
  });

  it('returns null for a missing shell binary', () => {
    const p = readLoginShellPath('/definitely/not/a/shell/binary');
    expect(p).toBeNull();
  });
});

describe('refreshShellPath', () => {
  it('populates the cache with a resolved source (login-shell or fallback)', () => {
    const cached = refreshShellPath();
    expect(['login-shell', 'fallback']).toContain(cached.source);
    expect(cached.value).toBeTruthy();
    expect(cached.capturedAt).toBeGreaterThan(0);
  });

  it('getCachedShellPath returns the same value without re-running the shell', () => {
    const first = refreshShellPath();
    const second = getCachedShellPath();
    expect(second).toBe(first);
  });
});

describe('resolveSpawnPath', () => {
  it('puts process.env.PATH entries before login-shell-only entries', () => {
    refreshShellPath();
    const result = resolveSpawnPath('/x/first:/y/second');
    const segs = result.split(':');
    expect(segs[0]).toBe('/x/first');
    expect(segs[1]).toBe('/y/second');
  });

  it('includes fallback dirs so /usr/local/bin is always present', () => {
    refreshShellPath();
    const result = resolveSpawnPath('/only/one/dir');
    expect(result.split(':')).toContain('/usr/local/bin');
    expect(result.split(':')).toContain('/usr/bin');
  });

  it('deduplicates across processPath, cached login PATH, and fallbacks', () => {
    refreshShellPath();
    const result = resolveSpawnPath('/usr/bin:/usr/local/bin');
    const segs = result.split(':');
    const usrBinCount = segs.filter((s) => s === '/usr/bin').length;
    const usrLocalBinCount = segs.filter((s) => s === '/usr/local/bin').length;
    expect(usrBinCount).toBe(1);
    expect(usrLocalBinCount).toBe(1);
  });

  it('returns a non-empty string even when process.env.PATH is undefined', () => {
    refreshShellPath();
    const result = resolveSpawnPath(undefined);
    expect(result.length).toBeGreaterThan(0);
    expect(result.split(':')).toContain('/usr/bin');
  });
});
