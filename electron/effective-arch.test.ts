import { describe, it, expect } from 'vitest';
import { resolveEffectiveArch } from './effective-arch.js';

describe('resolveEffectiveArch', () => {
  it('reports arm64 when an x64 build runs under Rosetta', () => {
    // Regression: the Intel build under translation reported `x64`, so the
    // update modal kept offering the Intel DMG forever.
    expect(resolveEffectiveArch('x64', true)).toBe('arm64');
  });

  it('passes the process arch through when not translated', () => {
    expect(resolveEffectiveArch('x64', false)).toBe('x64');
    expect(resolveEffectiveArch('arm64', false)).toBe('arm64');
    expect(resolveEffectiveArch('x64', undefined)).toBe('x64');
  });
});
