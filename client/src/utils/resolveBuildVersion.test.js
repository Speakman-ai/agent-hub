import { describe, it, expect, vi } from 'vitest';
import { resolveBuildVersion } from './resolveBuildVersion.js';

describe('resolveBuildVersion', () => {
  it('prefers VITE_APP_VERSION when set', () => {
    const readFile = vi.fn(); // must not be called
    const out = resolveBuildVersion({
      env: { VITE_APP_VERSION: '1.25.5' },
      rootPkgPath: '/fake/package.json',
      readFile,
    });
    expect(out).toBe('1.25.5');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('trims whitespace from VITE_APP_VERSION', () => {
    const out = resolveBuildVersion({
      env: { VITE_APP_VERSION: '  9.9.9  ' },
      rootPkgPath: '/fake/package.json',
      readFile: vi.fn(),
    });
    expect(out).toBe('9.9.9');
  });

  it('ignores empty/whitespace VITE_APP_VERSION and reads the root package.json', () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ version: '1.25.5' }));
    const out = resolveBuildVersion({
      env: { VITE_APP_VERSION: '   ' },
      rootPkgPath: '/repo/package.json',
      readFile,
    });
    expect(out).toBe('1.25.5');
    expect(readFile).toHaveBeenCalledWith('/repo/package.json', 'utf-8');
  });

  it('reads the root package.json when VITE_APP_VERSION is unset', () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ version: '1.25.5' }));
    const out = resolveBuildVersion({
      env: {},
      rootPkgPath: '/repo/package.json',
      readFile,
    });
    expect(out).toBe('1.25.5');
  });

  it('throws (rather than silently falling back) when the root package.json is missing', () => {
    // The old behavior silently fell back to client/package.json — which is
    // stuck at 1.2.1 — producing bundles that report a wildly stale version.
    // The new contract is: fail the build loudly. This test pins that.
    const readFile = vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(() =>
      resolveBuildVersion({ env: {}, rootPkgPath: '/missing/package.json', readFile }),
    ).toThrow(/ENOENT/);
  });

  it('throws if the root package.json is unparseable', () => {
    const readFile = vi.fn().mockReturnValue('{not json');
    expect(() =>
      resolveBuildVersion({ env: {}, rootPkgPath: '/repo/package.json', readFile }),
    ).toThrow(SyntaxError);
  });

  it('throws if the root package.json has no version field', () => {
    const readFile = vi.fn().mockReturnValue(JSON.stringify({ name: 'agent-hub' }));
    expect(() =>
      resolveBuildVersion({ env: {}, rootPkgPath: '/repo/package.json', readFile }),
    ).toThrow(/no usable "version" field/);
  });

  it('throws if VITE_APP_VERSION is unset and rootPkgPath is missing', () => {
    expect(() => resolveBuildVersion({ env: {}, readFile: vi.fn() })).toThrow(/rootPkgPath/);
  });
});
