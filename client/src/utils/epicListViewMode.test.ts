import { afterEach, describe, expect, it } from 'vitest';
import {
  isEpicListViewMode,
  readEpicListViewMode,
  writeEpicListViewMode,
} from './epicListViewMode';

afterEach(() => {
  localStorage.clear();
});

describe('isEpicListViewMode', () => {
  it('accepts only the two known modes', () => {
    expect(isEpicListViewMode('list')).toBe(true);
    expect(isEpicListViewMode('board')).toBe(true);
    expect(isEpicListViewMode('grid')).toBe(false);
    expect(isEpicListViewMode(null)).toBe(false);
    expect(isEpicListViewMode(undefined)).toBe(false);
  });
});

describe('readEpicListViewMode / writeEpicListViewMode', () => {
  it('defaults to list when nothing stored', () => {
    expect(readEpicListViewMode()).toBe('list');
  });

  it('round-trips a written value', () => {
    writeEpicListViewMode('board');
    expect(readEpicListViewMode()).toBe('board');
    writeEpicListViewMode('list');
    expect(readEpicListViewMode()).toBe('list');
  });

  it('falls back to list on a corrupt stored value', () => {
    localStorage.setItem('epicListViewMode', 'nonsense');
    expect(readEpicListViewMode()).toBe('list');
  });
});
