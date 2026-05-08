import { describe, it, expect } from 'vitest';
import { coerceConfigBooleanLoose } from './config.js';

describe('coerceConfigBooleanLoose', () => {
  it('accepts canonical booleans', () => {
    expect(coerceConfigBooleanLoose(true, false)).toBe(true);
    expect(coerceConfigBooleanLoose(false, true)).toBe(false);
  });

  it('accepts string true/false forms', () => {
    expect(coerceConfigBooleanLoose('true', false)).toBe(true);
    expect(coerceConfigBooleanLoose('FALSE', true)).toBe(false);
    expect(coerceConfigBooleanLoose('1', false)).toBe(true);
    expect(coerceConfigBooleanLoose('off', true)).toBe(false);
  });

  it('falls back when value is missing or unrecognized', () => {
    expect(coerceConfigBooleanLoose(undefined, false)).toBe(false);
    expect(coerceConfigBooleanLoose(42, true)).toBe(true);
  });
});
