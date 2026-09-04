import { describe, expect, it } from 'vitest';
import { parseNonNegativeIntEnv } from './preview-runtime-primitives.js';

describe('parseNonNegativeIntEnv', () => {
  it('returns undefined for unset or blank input', () => {
    expect(parseNonNegativeIntEnv(undefined)).toBeUndefined();
    expect(parseNonNegativeIntEnv('')).toBeUndefined();
    expect(parseNonNegativeIntEnv('   ')).toBeUndefined();
  });

  it('parses a non-negative integer, trimming whitespace', () => {
    expect(parseNonNegativeIntEnv('0')).toBe(0);
    expect(parseNonNegativeIntEnv('3')).toBe(3);
    expect(parseNonNegativeIntEnv('  1800  ')).toBe(1800);
  });

  it('rejects negatives, fractions, and non-numeric junk', () => {
    expect(parseNonNegativeIntEnv('-1')).toBeUndefined();
    expect(parseNonNegativeIntEnv('2.5')).toBeUndefined();
    expect(parseNonNegativeIntEnv('lots')).toBeUndefined();
    expect(parseNonNegativeIntEnv('10stacks')).toBeUndefined();
  });
});
