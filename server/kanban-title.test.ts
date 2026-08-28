import { describe, it, expect } from 'vitest';
import { normalizeKanbanTitle } from './kanban-title.js';

describe('normalizeKanbanTitle', () => {
  it('lowercases and trims', () => {
    expect(normalizeKanbanTitle('  Fix The Widget  ')).toBe('fix the widget');
  });

  it('folds non-ASCII case (the SQLite lower() gap this exists to close)', () => {
    expect(normalizeKanbanTitle('Éclair')).toBe(normalizeKanbanTitle('éclair'));
    expect(normalizeKanbanTitle('ÜBER')).toBe('über');
    expect(normalizeKanbanTitle('Straße')).toBe('straße');
  });

  it('tolerates null/undefined/number input', () => {
    expect(normalizeKanbanTitle(null)).toBe('');
    expect(normalizeKanbanTitle(undefined)).toBe('');
    expect(normalizeKanbanTitle(42)).toBe('42');
  });
});
