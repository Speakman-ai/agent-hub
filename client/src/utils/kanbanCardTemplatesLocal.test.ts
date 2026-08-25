import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLegacyLocalCardTemplates,
  readLegacyLocalCardTemplates,
  kanbanCardTemplatesKey,
} from './kanbanCardTemplatesLocal';

describe('kanbanCardTemplatesLocal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads legacy localStorage templates for migration', () => {
    localStorage.setItem(
      kanbanCardTemplatesKey('p1'),
      JSON.stringify([
        {
          id: 't1',
          name: 'Bug report',
          title: 'Fix:',
          description: 'Steps',
          priority: 'high',
          labels: 'bug',
          epicId: 'e1',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
    );
    const rows = readLegacyLocalCardTemplates('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Bug report');
    expect(readLegacyLocalCardTemplates('p2')).toEqual([]);
  });

  it('drops rows missing an id or name and junk priorities fall back to medium', () => {
    localStorage.setItem(
      kanbanCardTemplatesKey('p1'),
      JSON.stringify([{ id: 't1', name: 'Ok', priority: 'nonsense' }, { name: 'no id' }, null]),
    );
    const rows = readLegacyLocalCardTemplates('p1');
    expect(rows).toHaveLength(1);
    expect(rows[0].priority).toBe('medium');
    expect(rows[0].title).toBe('');
  });

  it('returns [] for malformed JSON and clears the legacy key', () => {
    localStorage.setItem(kanbanCardTemplatesKey('p1'), '{not json');
    expect(readLegacyLocalCardTemplates('p1')).toEqual([]);
    localStorage.setItem(kanbanCardTemplatesKey('p1'), '[]');
    clearLegacyLocalCardTemplates('p1');
    expect(localStorage.getItem(kanbanCardTemplatesKey('p1'))).toBeNull();
  });
});
