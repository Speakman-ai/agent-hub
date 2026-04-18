import { describe, it, expect } from 'vitest';
import {
  parseAllowlist,
  serializeAllowlist,
  parseAllowlistFromBackend,
} from './authorAllowlist.js';

describe('parseAllowlist', () => {
  it('returns [] for non-string input', () => {
    expect(parseAllowlist(null)).toEqual([]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist(123)).toEqual([]);
    expect(parseAllowlist([])).toEqual([]);
  });

  it('splits by comma and trims entries', () => {
    expect(parseAllowlist('mcsteen, alice, bob')).toEqual(['mcsteen', 'alice', 'bob']);
  });

  it('drops empty / whitespace-only entries', () => {
    expect(parseAllowlist('mcsteen, ,  , alice')).toEqual(['mcsteen', 'alice']);
    expect(parseAllowlist('')).toEqual([]);
  });

  it('dedupes case-insensitively, keeping the first occurrence casing', () => {
    expect(parseAllowlist('McSteen, alice, MCSTEEN, Alice')).toEqual(['McSteen', 'alice']);
  });
});

describe('serializeAllowlist', () => {
  it('joins with ", "', () => {
    expect(serializeAllowlist(['mcsteen', 'alice'])).toBe('mcsteen, alice');
  });

  it('returns "" for empty array', () => {
    expect(serializeAllowlist([])).toBe('');
  });

  it('returns "" for non-array input', () => {
    expect(serializeAllowlist(null)).toBe('');
    expect(serializeAllowlist('mcsteen')).toBe('');
    expect(serializeAllowlist(undefined)).toBe('');
  });

  it('drops non-string / empty entries defensively', () => {
    expect(serializeAllowlist(['mcsteen', '', '   ', null, 42, 'alice'])).toBe('mcsteen, alice');
  });
});

describe('parseAllowlistFromBackend', () => {
  it('returns [] for null / empty', () => {
    expect(parseAllowlistFromBackend(null)).toEqual([]);
    expect(parseAllowlistFromBackend(undefined)).toEqual([]);
    expect(parseAllowlistFromBackend('')).toEqual([]);
  });

  it('parses a JSON string array', () => {
    expect(parseAllowlistFromBackend('["mcsteen","alice"]')).toEqual(['mcsteen', 'alice']);
  });

  it('passes through an already-array value and filters non-strings', () => {
    expect(parseAllowlistFromBackend(['mcsteen', 42, 'alice', null])).toEqual(['mcsteen', 'alice']);
  });

  it('returns [] for malformed JSON (never throws)', () => {
    expect(parseAllowlistFromBackend('not json')).toEqual([]);
    expect(parseAllowlistFromBackend('{"not":"array"}')).toEqual([]);
  });

  it('returns [] for non-string non-array values', () => {
    expect(parseAllowlistFromBackend(42)).toEqual([]);
    expect(parseAllowlistFromBackend({})).toEqual([]);
  });
});
