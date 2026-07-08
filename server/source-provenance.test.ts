import { describe, it, expect } from 'vitest';
import {
  parseSourceMeta,
  serializeSourceMeta,
  CARD_SOURCE_TYPES,
  TODO_SOURCE_TYPES,
} from './source-provenance.js';

describe('source-provenance shared shape', () => {
  it('cards allow `todo`; todos never do', () => {
    expect(CARD_SOURCE_TYPES).toContain('todo');
    expect(TODO_SOURCE_TYPES).not.toContain('todo');
    // Every todo source is a valid card source (cards are a superset).
    for (const t of TODO_SOURCE_TYPES) {
      expect(CARD_SOURCE_TYPES).toContain(t);
    }
  });

  it('parseSourceMeta round-trips an object through the stored JSON blob', () => {
    const meta = { link: 'https://example.com/x', id: 42 };
    const stored = serializeSourceMeta(meta);
    expect(typeof stored).toBe('string');
    expect(parseSourceMeta(stored)).toEqual(meta);
  });

  it('serializeSourceMeta returns null for null/undefined', () => {
    expect(serializeSourceMeta(null)).toBeNull();
    expect(serializeSourceMeta(undefined)).toBeNull();
  });

  it('parseSourceMeta is defensive: null, malformed, and non-objects → null', () => {
    expect(parseSourceMeta(null)).toBeNull();
    expect(parseSourceMeta(undefined)).toBeNull();
    expect(parseSourceMeta('not json')).toBeNull();
    expect(parseSourceMeta('[1,2,3]')).toBeNull(); // arrays are not keyed meta
    expect(parseSourceMeta('"scalar"')).toBeNull();
    expect(parseSourceMeta('42')).toBeNull();
  });
});
