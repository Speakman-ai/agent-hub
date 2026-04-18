import { describe, it, expect } from 'vitest';
import {
  EPIC_COLORS,
  DEFAULT_EPIC_COLOR,
  DEFAULT_EPIC_FORM,
  epicFormFromRow,
  epicFormToUpdateBody,
  epicFormToCreateBody,
  filterCardsByEpic,
  countOpenCardsForEpic,
  findEpic,
  epicDropdownLabel,
} from './epics.js';

describe('EPIC_COLORS', () => {
  it('matches the web palette', () => {
    expect(EPIC_COLORS).toEqual([
      '#6366F1',
      '#8B5CF6',
      '#EC4899',
      '#EF4444',
      '#F97316',
      '#EAB308',
      '#22C55E',
      '#06B6D4',
      '#3B82F6',
    ]);
    expect(EPIC_COLORS).toContain(DEFAULT_EPIC_COLOR);
  });
});

describe('DEFAULT_EPIC_FORM', () => {
  it('defaults autonomous fields to sane values', () => {
    expect(DEFAULT_EPIC_FORM).toEqual({
      name: '',
      description: '',
      color: DEFAULT_EPIC_COLOR,
      autonomous: 0,
      autonomous_interval: 5,
      autonomous_max_concurrent: 2,
      autonomous_max_iterations: 3,
    });
  });
});

describe('epicFormFromRow', () => {
  it('returns defaults for a nullish row', () => {
    expect(epicFormFromRow(null)).toEqual(DEFAULT_EPIC_FORM);
    expect(epicFormFromRow(undefined)).toEqual(DEFAULT_EPIC_FORM);
  });

  it('maps server fields into the form, coercing autonomous to 0/1', () => {
    const row = {
      id: 'e1',
      name: 'Ship the app',
      description: 'big epic',
      color: '#22C55E',
      autonomous: 1,
      autonomous_interval: 10,
      autonomous_max_concurrent: 4,
      autonomous_max_iterations: 8,
    };
    expect(epicFormFromRow(row)).toEqual({
      name: 'Ship the app',
      description: 'big epic',
      color: '#22C55E',
      autonomous: 1,
      autonomous_interval: 10,
      autonomous_max_concurrent: 4,
      autonomous_max_iterations: 8,
    });
  });

  it('coerces truthy autonomous to 1', () => {
    expect(epicFormFromRow({ name: 'x', autonomous: true }).autonomous).toBe(1);
    expect(epicFormFromRow({ name: 'x', autonomous: 0 }).autonomous).toBe(0);
    expect(epicFormFromRow({ name: 'x' }).autonomous).toBe(0);
  });

  it('falls back to DEFAULT_EPIC_COLOR when color is missing', () => {
    expect(epicFormFromRow({ name: 'x' }).color).toBe(DEFAULT_EPIC_COLOR);
  });
});

describe('epicFormToUpdateBody', () => {
  it('emits the camelCase keys the server PUT endpoint expects', () => {
    const form = {
      name: '  Trim me  ',
      description: 'desc',
      color: '#EC4899',
      autonomous: 1,
      autonomous_interval: 7,
      autonomous_max_concurrent: 3,
      autonomous_max_iterations: 5,
    };
    expect(epicFormToUpdateBody(form)).toEqual({
      name: 'Trim me',
      description: 'desc',
      color: '#EC4899',
      autonomous: 1,
      autonomousInterval: 7,
      autonomousMaxConcurrent: 3,
      autonomousMaxIterations: 5,
    });
  });

  it('coerces autonomous falsy values to 0', () => {
    expect(epicFormToUpdateBody({ name: 'a', autonomous: false }).autonomous).toBe(0);
    expect(epicFormToUpdateBody({ name: 'a', autonomous: undefined }).autonomous).toBe(0);
  });
});

describe('epicFormToCreateBody', () => {
  it('only sends the subset supported by POST /board/epics', () => {
    const form = {
      name: 'New epic',
      description: 'desc',
      color: '#EAB308',
      autonomous: 1, // should be ignored — create endpoint doesn't accept it
      autonomous_interval: 10,
    };
    expect(epicFormToCreateBody(form)).toEqual({
      name: 'New epic',
      description: 'desc',
      color: '#EAB308',
    });
  });
});

describe('filterCardsByEpic', () => {
  const cards = [
    { id: 1, epic_id: 'e1', column_id: 'todo' },
    { id: 2, epic_id: 'e2', column_id: 'todo' },
    { id: 3, epic_id: null, column_id: 'todo' },
  ];

  it('returns all cards when filter is null/undefined', () => {
    expect(filterCardsByEpic(cards, null)).toEqual(cards);
    expect(filterCardsByEpic(cards, undefined)).toEqual(cards);
  });

  it('returns only cards for the given epic id', () => {
    expect(filterCardsByEpic(cards, 'e1')).toEqual([cards[0]]);
    expect(filterCardsByEpic(cards, 'e2')).toEqual([cards[1]]);
  });

  it('handles non-array input defensively', () => {
    expect(filterCardsByEpic(null, 'e1')).toEqual([]);
  });
});

describe('countOpenCardsForEpic', () => {
  const cards = [
    { id: 1, epic_id: 'e1', column_id: 'in-progress' },
    { id: 2, epic_id: 'e1', column_id: 'done' },
    { id: 3, epic_id: 'e1', column_id: 'todo' },
    { id: 4, epic_id: 'e2', column_id: 'todo' },
  ];

  it('counts non-done cards only', () => {
    expect(countOpenCardsForEpic(cards, 'e1', new Set(['done']))).toBe(2);
  });

  it('accepts a plain array as the done-column ids parameter', () => {
    expect(countOpenCardsForEpic(cards, 'e1', ['done'])).toBe(2);
  });

  it('treats every column as open if no done ids provided', () => {
    expect(countOpenCardsForEpic(cards, 'e1')).toBe(3);
  });

  it('returns 0 for missing epic id', () => {
    expect(countOpenCardsForEpic(cards, null)).toBe(0);
  });
});

describe('findEpic', () => {
  const epics = [
    { id: 'e1', name: 'Alpha' },
    { id: 'e2', name: 'Beta' },
  ];

  it('finds an epic by id', () => {
    expect(findEpic(epics, 'e2')).toEqual({ id: 'e2', name: 'Beta' });
  });

  it('returns null for missing input', () => {
    expect(findEpic(epics, 'nope')).toBeNull();
    expect(findEpic(null, 'e1')).toBeNull();
    expect(findEpic(epics, null)).toBeNull();
  });
});

describe('epicDropdownLabel', () => {
  it('prepends the zap glyph for autonomous epics (parity with web)', () => {
    expect(epicDropdownLabel({ name: 'Live', autonomous: 1 })).toBe('\u26A1 Live');
  });

  it('omits the glyph for non-autonomous epics', () => {
    expect(epicDropdownLabel({ name: 'Idle', autonomous: 0 })).toBe('Idle');
  });

  it('returns empty for nullish epic', () => {
    expect(epicDropdownLabel(null)).toBe('');
  });
});
