import { describe, expect, it } from 'vitest';
import {
  backgroundAgentsFormReducer as reduce,
  initialBackgroundAgentsForm,
  isBackgroundAgentsFormDirty,
} from './backgroundAgentsForm';

const project = (enabled: boolean, schedule: string) => ({
  backgroundAgents: { wiki: { enabled, schedule }, custom: [] },
});
const toggle = (enabled: boolean) =>
  ({ type: 'edit', update: (f: any) => ({ ...f, wiki: { ...f.wiki, enabled } }) }) as const;

describe('backgroundAgentsFormReducer', () => {
  it('follows the server until the user edits', () => {
    let form = initialBackgroundAgentsForm(null);
    form = reduce(form, { type: 'hydrate', project: project(true, '0 5 * * *') });
    expect(form.wiki).toMatchObject({ enabled: true, schedule: '0 5 * * *' });
    form = reduce(form, toggle(false));
    expect(isBackgroundAgentsFormDirty(form)).toBe(true);
    form = reduce(form, { type: 'hydrate', project: project(true, '0 6 * * *') });
    expect(form.wiki).toMatchObject({ enabled: false, schedule: '0 5 * * *' });
  });

  it('follows the server again once a save confirms the submitted input', () => {
    let form = initialBackgroundAgentsForm(project(true, '0 1 * * *'));
    form = reduce(form, toggle(false));
    form = reduce(form, { type: 'saved', edits: form.edits });
    expect(isBackgroundAgentsFormDirty(form)).toBe(false);
    form = reduce(form, { type: 'hydrate', project: project(false, '0 1 * * *') });
    form = reduce(form, { type: 'hydrate', project: project(true, '0 9 * * *') });
    expect(form.wiki).toMatchObject({ enabled: true, schedule: '0 9 * * *' });
  });

  it('keeps edits made while a save was in flight', () => {
    let form = initialBackgroundAgentsForm(project(true, '0 1 * * *'));
    form = reduce(form, toggle(false));
    const submitted = form.edits;
    form = reduce(form, toggle(true));
    form = reduce(form, { type: 'saved', edits: submitted });
    expect(isBackgroundAgentsFormDirty(form)).toBe(true);
    form = reduce(form, { type: 'hydrate', project: project(false, '0 1 * * *') });
    expect(form.wiki.enabled).toBe(true);
  });

  it('ignores edits until the project config has loaded, then takes it whole', () => {
    let form = initialBackgroundAgentsForm(null);
    expect(form.loaded).toBe(false);
    form = reduce(form, toggle(true));
    expect(isBackgroundAgentsFormDirty(form)).toBe(false);
    form = reduce(form, {
      type: 'hydrate',
      project: {
        backgroundAgents: {
          wiki: { enabled: false, schedule: '0 2 * * *', ownerUserId: 'u1', model: 'opus' },
          custom: [{ id: 'c1', name: 'Digest', prompt: 'Sum', skills: ['wiki'] }],
        },
      },
    });
    expect(form.loaded).toBe(true);
    expect(form.wiki).toMatchObject({ enabled: false, ownerUserId: 'u1', model: 'opus' });
    expect(form.custom).toEqual([{ id: 'c1', name: 'Digest', prompt: 'Sum', skills: ['wiki'] }]);
  });
});
