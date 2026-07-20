import { describe, it, expect } from 'vitest';
import {
  applyCardTemplateToDetailForm,
  blankCardTemplateInput,
  cardTemplateApiBody,
  normalizeCardTemplate,
  normalizeCardTemplatePriority,
  templateCreateCardPayload,
  type KanbanCardTemplate,
} from './kanbanCardTemplates';

const TEMPLATE: KanbanCardTemplate = {
  id: 't1',
  name: 'Bug report',
  title: 'Fix login',
  description: 'Steps to reproduce',
  priority: 'high',
  labels: 'bug,urgent',
  epicId: 'e2',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('shared kanbanCardTemplates', () => {
  it('blankCardTemplateInput defaults, with optional name seed', () => {
    expect(blankCardTemplateInput()).toEqual({
      name: '',
      title: '',
      description: '',
      priority: 'medium',
      labels: '',
      epicId: '',
    });
    expect(blankCardTemplateInput('Seed').name).toBe('Seed');
  });

  it('normalizeCardTemplatePriority falls back to medium for junk', () => {
    expect(normalizeCardTemplatePriority('urgent')).toBe('urgent');
    expect(normalizeCardTemplatePriority('bogus')).toBe('medium');
    expect(normalizeCardTemplatePriority(undefined)).toBe('medium');
  });

  it('normalizeCardTemplate coerces a partial row to safe defaults', () => {
    const t = normalizeCardTemplate({ id: 'x', name: 'N', priority: 'nope' });
    expect(t).toMatchObject({
      id: 'x',
      name: 'N',
      title: '',
      description: '',
      priority: 'medium',
      labels: '',
      epicId: '',
    });
    expect(typeof t.updatedAt).toBe('string');
  });

  it('cardTemplateApiBody trims name and nulls empty optionals', () => {
    expect(
      cardTemplateApiBody({
        name: '  Bug  ',
        title: 'T',
        description: '',
        priority: 'low',
        labels: '',
        epicId: '',
      }),
    ).toEqual({
      name: 'Bug',
      title: 'T',
      description: null,
      priority: 'low',
      labels: null,
      epicId: null,
    });
    expect(cardTemplateApiBody({ ...TEMPLATE }).description).toBe('Steps to reproduce');
    expect(cardTemplateApiBody({ ...TEMPLATE }).epicId).toBe('e2');
  });

  it('applyCardTemplateToDetailForm fills detail fields (epic_id snake_case)', () => {
    const form = applyCardTemplateToDetailForm({ title: 'old', priority: 'low' }, TEMPLATE);
    expect(form.title).toBe('Fix login');
    expect(form.description).toBe('Steps to reproduce');
    expect(form.priority).toBe('high');
    expect(form.labels).toBe('bug,urgent');
    expect(form.epic_id).toBe('e2');
  });

  it('templateCreateCardPayload builds an apply-on-create payload', () => {
    expect(templateCreateCardPayload(TEMPLATE, { columnId: 'col1' })).toEqual({
      title: 'Fix login',
      columnId: 'col1',
      priority: 'high',
      description: 'Steps to reproduce',
      labels: 'bug,urgent',
      epicId: 'e2',
    });
  });

  it('templateCreateCardPayload lets an active epic filter override the template epic', () => {
    const payload = templateCreateCardPayload(TEMPLATE, { columnId: 'col1', epicId: 'filtered' });
    expect(payload.epicId).toBe('filtered');
  });

  it('templateCreateCardPayload omits empty description/labels/epic and uses a title override', () => {
    const bare: KanbanCardTemplate = {
      ...blankCardTemplateInput('Bare'),
      id: 'b',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const payload = templateCreateCardPayload(bare, { columnId: 'col2', title: 'Typed title' });
    expect(payload).toEqual({ title: 'Typed title', columnId: 'col2', priority: 'medium' });
    expect(payload.description).toBeUndefined();
    expect(payload.labels).toBeUndefined();
    expect(payload.epicId).toBeUndefined();
  });
});
