import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  serializeAllowlist,
  parseAllowlistFromBackend,
} from './authorAllowlist.js';

describe('parseAllowlist', () => {
  it('splits on commas and trims', () => {
    expect(parseAllowlist('mcsteen, alice, bob')).toEqual(['mcsteen', 'alice', 'bob']);
  });

  it('drops empty / whitespace-only entries', () => {
    expect(parseAllowlist('mcsteen, , alice,,, bob  ')).toEqual(['mcsteen', 'alice', 'bob']);
  });

  it('dedupes case-insensitively, preserving first-occurrence casing', () => {
    expect(parseAllowlist('mcsteen, MCSteen, alice, Alice')).toEqual(['mcsteen', 'alice']);
  });

  it('returns empty array for empty string', () => {
    expect(parseAllowlist('')).toEqual([]);
  });

  it('returns empty array for non-string input', () => {
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist(42)).toEqual([]);
  });
});

describe('serializeAllowlist', () => {
  it('joins with ", "', () => {
    expect(serializeAllowlist(['mcsteen', 'alice'])).toBe('mcsteen, alice');
  });

  it('returns empty string for empty array', () => {
    expect(serializeAllowlist([])).toBe('');
  });

  it('drops non-string and empty entries', () => {
    expect(serializeAllowlist(['mcsteen', '', null, 'alice', '   '])).toBe('mcsteen, alice');
  });

  it('returns empty string for non-array input', () => {
    expect(serializeAllowlist(null)).toBe('');
    expect(serializeAllowlist('mcsteen')).toBe('');
  });
});

describe('parseAllowlistFromBackend', () => {
  it('parses a JSON string array', () => {
    expect(parseAllowlistFromBackend('["mcsteen","alice"]')).toEqual(['mcsteen', 'alice']);
  });

  it('returns empty array for empty / null / undefined', () => {
    expect(parseAllowlistFromBackend('')).toEqual([]);
    expect(parseAllowlistFromBackend(null)).toEqual([]);
    expect(parseAllowlistFromBackend(undefined)).toEqual([]);
  });

  it('tolerates malformed JSON (returns [])', () => {
    expect(parseAllowlistFromBackend('{not json')).toEqual([]);
  });

  it('returns [] for JSON that is not an array', () => {
    expect(parseAllowlistFromBackend('"mcsteen"')).toEqual([]);
    expect(parseAllowlistFromBackend('{"login":"mcsteen"}')).toEqual([]);
  });

  it('accepts an already-parsed array pass-through', () => {
    expect(parseAllowlistFromBackend(['mcsteen', 'alice'])).toEqual(['mcsteen', 'alice']);
  });

  it('filters non-string entries', () => {
    expect(parseAllowlistFromBackend('["mcsteen",42,null]')).toEqual(['mcsteen']);
  });
});
