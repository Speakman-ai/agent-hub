import { describe, it, expect } from 'vitest';
import { cardShortLabel, assigneeInitials, assigneeColorClass } from './kanbanCard';

describe('cardShortLabel', () => {
  it('joins prefix and number', () => {
    expect(cardShortLabel('AH', 123)).toBe('AH-123');
  });

  it('falls back to CARD when prefix missing', () => {
    expect(cardShortLabel('', 5)).toBe('CARD-5');
    expect(cardShortLabel(null, 5)).toBe('CARD-5');
    expect(cardShortLabel(undefined, 5)).toBe('CARD-5');
  });

  it('returns null when short_id is missing (legacy rows)', () => {
    expect(cardShortLabel('AH', null)).toBeNull();
    expect(cardShortLabel('AH', undefined)).toBeNull();
  });
});

describe('assigneeInitials', () => {
  it('takes the first letter of the first two words', () => {
    expect(assigneeInitials('Agent Hub Dev')).toBe('AH');
  });

  it('takes the first two letters of a single word', () => {
    expect(assigneeInitials('payments')).toBe('PA');
  });

  it('handles hyphen / underscore separators', () => {
    expect(assigneeInitials('agent-hub')).toBe('AH');
    expect(assigneeInitials('foo_bar')).toBe('FB');
  });

  it('returns empty string for blank input', () => {
    expect(assigneeInitials('')).toBe('');
    expect(assigneeInitials('   ')).toBe('');
    expect(assigneeInitials(null)).toBe('');
  });
});

describe('assigneeColorClass', () => {
  it('is deterministic for a given name', () => {
    expect(assigneeColorClass('Agent Hub Dev')).toBe(assigneeColorClass('Agent Hub Dev'));
  });

  it('always returns a non-empty palette class', () => {
    expect(assigneeColorClass('whoever')).toMatch(/bg-/);
    expect(assigneeColorClass('')).toMatch(/bg-/);
  });
});
