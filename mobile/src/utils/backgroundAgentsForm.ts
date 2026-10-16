import { DEFAULT_BACKGROUND_SCHEDULE } from './backgroundAgents';

/**
 * Background Agents editor state. `edits` counts user edits; `synced` is the
 * edit count at which the form last matched the server (loaded from it, or
 * confirmed by a save). The form is dirty while they differ, and a dirty form
 * never takes the server's config over the user's input.
 */
export interface BackgroundAgentsForm {
  wiki: any;
  custom: any[];
  edits: number;
  synced: number;
  /**
   * The server's config has been loaded. Until then the form holds defaults,
   * not the project's config, so it refuses edits: an edit would make it
   * dirty, block the first hydration, and let Save send defaults over the
   * real config (dropping custom agents and owner/model/skills).
   */
  loaded: boolean;
}

export type BackgroundAgentsFormAction =
  | { type: 'edit'; update: (form: { wiki: any; custom: any[] }) => { wiki: any; custom: any[] } }
  | { type: 'hydrate'; project: any }
  | { type: 'saved'; edits: number };

function configOf(project: any) {
  const savedWiki = project?.backgroundAgents?.wiki || {};
  const savedCustom = Array.isArray(project?.backgroundAgents?.custom)
    ? project.backgroundAgents.custom
    : [];
  return {
    wiki: { ...savedWiki, schedule: savedWiki.schedule || DEFAULT_BACKGROUND_SCHEDULE },
    custom: savedCustom.map((agent: any) => ({ ...agent })),
  };
}

export function initialBackgroundAgentsForm(project: any): BackgroundAgentsForm {
  return { ...configOf(project), edits: 0, synced: 0, loaded: !!project };
}

export function isBackgroundAgentsFormDirty(form: BackgroundAgentsForm): boolean {
  return form.edits !== form.synced;
}

export function backgroundAgentsFormReducer(
  form: BackgroundAgentsForm,
  action: BackgroundAgentsFormAction,
): BackgroundAgentsForm {
  switch (action.type) {
    case 'edit': {
      if (!form.loaded) return form;
      const next = action.update({ wiki: form.wiki, custom: form.custom });
      return { ...form, ...next, edits: form.edits + 1 };
    }
    case 'hydrate':
      if (!action.project) return form;
      if (!form.loaded) return { ...form, ...configOf(action.project), loaded: true };
      if (isBackgroundAgentsFormDirty(form)) return form;
      return { ...form, ...configOf(action.project) };
    case 'saved':
      // A save only confirms the input it submitted. Edits made while it was
      // in flight keep the form dirty, so the refreshed project cannot replace
      // them.
      return form.edits === action.edits ? { ...form, synced: action.edits } : form;
  }
}
