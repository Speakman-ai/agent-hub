import { describe, it, expect } from 'vitest';
import { deriveCardPrefix, formatCardShortId } from './kanban-short-id.js';

describe('deriveCardPrefix', () => {
  it('builds initials from a hyphenated slug', () => {
    expect(deriveCardPrefix('agent-hub')).toBe('AH');
  });

  it('builds initials from a multi-word name', () => {
    expect(deriveCardPrefix('Acme Web Platform')).toBe('AWP');
  });

  it('splits camelCase into initials', () => {
    expect(deriveCardPrefix('agentHub')).toBe('AH');
  });

  it('uses the first three letters of a single word', () => {
    expect(deriveCardPrefix('payments')).toBe('PAY');
  });

  it('caps prefixes at four characters', () => {
    expect(deriveCardPrefix('one two three four five')).toBe('OTTF');
  });

  it('strips punctuation and uppercases', () => {
    expect(deriveCardPrefix('my_project.v2')).toBe('MPV');
  });

  it('falls back for empty / punctuation-only input', () => {
    expect(deriveCardPrefix('')).toBe('CARD');
    expect(deriveCardPrefix('   ')).toBe('CARD');
    expect(deriveCardPrefix('---')).toBe('CARD');
    expect(deriveCardPrefix(null)).toBe('CARD');
    expect(deriveCardPrefix(undefined)).toBe('CARD');
  });

  it('keeps at least two characters for short single words', () => {
    expect(deriveCardPrefix('a').length).toBeGreaterThanOrEqual(2);
    expect(deriveCardPrefix('go')).toBe('GO');
  });
});

describe('formatCardShortId', () => {
  it('joins prefix and number', () => {
    expect(formatCardShortId('AH', 123)).toBe('AH-123');
  });

  it('falls back to CARD when prefix missing', () => {
    expect(formatCardShortId('', 5)).toBe('CARD-5');
    expect(formatCardShortId(null, 5)).toBe('CARD-5');
  });

  it('returns null for a missing short id (legacy rows)', () => {
    expect(formatCardShortId('AH', null)).toBeNull();
    expect(formatCardShortId('AH', undefined)).toBeNull();
  });
});
