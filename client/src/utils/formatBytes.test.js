import { describe, it, expect } from 'vitest';
import { formatInjectedBytes } from './formatBytes.js';

describe('formatInjectedBytes', () => {
  it('formats byte sizes for display', () => {
    expect(formatInjectedBytes(0)).toBe('');
    expect(formatInjectedBytes(512)).toBe('512 B');
    expect(formatInjectedBytes(4096)).toBe('4.0 KB');
    expect(formatInjectedBytes(2_000_000)).toBe('1.9 MB');
  });
});
