import { describe, it, expect } from 'vitest';
import path from 'path';
import { extraPathSegmentsForPlatform, mergeElectronServerPath } from './merge-server-path.js';

describe('extraPathSegmentsForPlatform', () => {
  it('includes Homebrew and user-local Unix paths', () => {
    const segs = extraPathSegmentsForPlatform('linux', { HOME: '/home/u' });
    expect(segs).toContain('/opt/homebrew/bin');
    expect(segs).toContain(path.join('/home/u', '.local', 'bin'));
    expect(segs).toContain(path.join('/home/u', '.nvm', 'versions', 'node', 'current', 'bin'));
  });

  it('includes Git and GitHub CLI paths on Windows', () => {
    const env = {
      ProgramFiles: 'C:\\Program Files',
      'ProgramFiles(x86)': 'C:\\Program Files (x86)',
      LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
      USERPROFILE: 'C:\\Users\\x',
    };
    const segs = extraPathSegmentsForPlatform('win32', env);
    expect(segs).toContain('C:\\Program Files\\Git\\cmd');
    expect(segs).toContain('C:\\Program Files\\GitHub CLI');
    expect(segs).toContain(path.win32.join(env.LOCALAPPDATA, 'GitHub CLI'));
  });
});

describe('mergeElectronServerPath', () => {
  it('uses the platform delimiter (semicolon on Windows)', () => {
    const merged = mergeElectronServerPath(
      'C:\\Windows\\System32',
      {
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\x',
      },
      'win32',
    );
    expect(merged.includes(';')).toBe(true);
    expect(merged.startsWith('C:\\Program Files\\Git\\cmd')).toBe(true);
    expect(merged).toContain('C:\\Windows\\System32');
  });

  it('on Unix, prepends extras then system PATH with colon delimiter', () => {
    const merged = mergeElectronServerPath('/usr/bin:/bin', { HOME: '/home/u' }, 'linux');
    expect(merged.startsWith('/opt/homebrew/bin:')).toBe(true);
    expect(merged).toContain('/usr/bin');
    expect(merged).toContain('/bin');
  });

  it('deduplicates repeated segments', () => {
    const merged = mergeElectronServerPath(
      '/opt/homebrew/bin:/usr/bin',
      { HOME: '/home/u' },
      'linux',
    );
    const parts = merged.split(':');
    const optCount = parts.filter((p) => p === '/opt/homebrew/bin').length;
    expect(optCount).toBe(1);
  });
});
