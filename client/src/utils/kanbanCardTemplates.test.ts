import { describe, it, expect, beforeEach } from 'vitest';
import {
  readLegacyLocalCardTemplates,
  applyCardTemplateToDetailForm,
  blankCardTemplateInput,
  kanbanCardTemplatesKey,
} from './kanbanCardTemplates';

describe('kanbanCardTemplates', () => {
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

  it('applyCardTemplateToDetailForm fills detail fields', () => {
    const form = applyCardTemplateToDetailForm(
      { title: 'old', priority: 'low' },
      {
        id: 't1',
        name: 'Bug',
        title: 'Fix login',
        description: 'Details',
        priority: 'high',
        labels: 'bug,urgent',
        epicId: 'e2',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(form.title).toBe('Fix login');
    expect(form.description).toBe('Details');
    expect(form.priority).toBe('high');
    expect(form.labels).toBe('bug,urgent');
    expect(form.epic_id).toBe('e2');
  });

  it('blankCardTemplateInput defaults', () => {
    expect(blankCardTemplateInput()).toMatchObject({
      name: '',
      title: '',
      priority: 'medium',
      labels: '',
      epicId: '',
    });
  });
});
