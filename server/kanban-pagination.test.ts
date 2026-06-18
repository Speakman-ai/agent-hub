import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CARD_PAGE_SIZE,
  MAX_CARD_PAGE_SIZE,
  clampPageLimit,
  decodeCardCursor,
  encodeCardCursor,
} from './kanban-pagination.js';

describe('kanban-pagination cursor', () => {
  it('round-trips a cursor through encode/decode', () => {
    const cursor = { position: 7, id: 'abc-123-uuid' };
    const token = encodeCardCursor(cursor);
    expect(token).not.toContain(':'); // opaque (base64url)
    expect(decodeCardCursor(token)).toEqual(cursor);
  });

  it('round-trips position 0 and negative positions', () => {
    expect(decodeCardCursor(encodeCardCursor({ position: 0, id: 'x' }))).toEqual({
      position: 0,
      id: 'x',
    });
    expect(decodeCardCursor(encodeCardCursor({ position: -3, id: 'y' }))).toEqual({
      position: -3,
      id: 'y',
    });
  });

  it('preserves ids containing extra colons (only first colon splits)', () => {
    const cursor = { position: 5, id: 'weird:id:with:colons' };
    expect(decodeCardCursor(encodeCardCursor(cursor))).toEqual(cursor);
  });

  it('returns null for malformed cursors', () => {
    expect(decodeCardCursor('')).toBeNull();
    // base64url of "noColonHere"
    expect(decodeCardCursor(Buffer.from('noColonHere').toString('base64url'))).toBeNull();
    // empty id
    expect(decodeCardCursor(Buffer.from('5:').toString('base64url'))).toBeNull();
    // non-integer position
    expect(decodeCardCursor(Buffer.from('abc:id').toString('base64url'))).toBeNull();
    // empty position
    expect(decodeCardCursor(Buffer.from(':id').toString('base64url'))).toBeNull();
  });
});

describe('kanban-pagination clampPageLimit', () => {
  it('defaults when missing / empty / non-numeric', () => {
    expect(clampPageLimit(undefined)).toBe(DEFAULT_CARD_PAGE_SIZE);
    expect(clampPageLimit(null)).toBe(DEFAULT_CARD_PAGE_SIZE);
    expect(clampPageLimit('')).toBe(DEFAULT_CARD_PAGE_SIZE);
    expect(clampPageLimit('not-a-number')).toBe(DEFAULT_CARD_PAGE_SIZE);
  });

  it('parses and floors numeric strings', () => {
    expect(clampPageLimit('25')).toBe(25);
    expect(clampPageLimit('25.9')).toBe(25);
    expect(clampPageLimit(30)).toBe(30);
  });

  it('clamps to [1, MAX]', () => {
    expect(clampPageLimit('0')).toBe(1);
    expect(clampPageLimit('-5')).toBe(1);
    expect(clampPageLimit(String(MAX_CARD_PAGE_SIZE + 100))).toBe(MAX_CARD_PAGE_SIZE);
  });

  it('uses the first element when given an array (Express repeated query)', () => {
    expect(clampPageLimit(['10', '20'])).toBe(10);
  });
});
