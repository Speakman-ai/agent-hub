import { describe, it, expect } from 'vitest';
import { trimTrailingSlashes } from './trimTrailingSlashes.js';

describe('trimTrailingSlashes', () => {
  it('returns "" for non-string / unset values (the disabled default)', () => {
    expect(trimTrailingSlashes(undefined)).toBe('');
    expect(trimTrailingSlashes(null)).toBe('');
    expect(trimTrailingSlashes(123)).toBe('');
    expect(trimTrailingSlashes({})).toBe('');
    expect(trimTrailingSlashes('')).toBe('');
    expect(trimTrailingSlashes('   ')).toBe('');
  });

  it('trims surrounding whitespace and strips trailing slashes', () => {
    expect(trimTrailingSlashes('https://hub.example.test/api/bug-reports')).toBe(
      'https://hub.example.test/api/bug-reports',
    );
    expect(trimTrailingSlashes('  https://hub.example.test/api/bug-reports/  ')).toBe(
      'https://hub.example.test/api/bug-reports',
    );
    expect(trimTrailingSlashes('https://releases.example.test///')).toBe(
      'https://releases.example.test',
    );
  });
});
