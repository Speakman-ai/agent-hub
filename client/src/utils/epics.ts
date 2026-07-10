// Pure helpers for kanban epic management (web).
// Mirrors mobile/src/utils/epics.js so that web and mobile send the same
// request shape to the server's /board/epics endpoints.
//
// Why this exists: the form state uses snake_case keys for parity with the
// database columns (autonomous_max_concurrent, autonomous_interval), but the
// server's PUT route destructures camelCase keys (autonomousMaxConcurrent,
// autonomousInterval). Without this translation the values arrive as
// `undefined` on the server and the `?? epic.autonomous_max_concurrent`
// fallback silently preserves the old value — i.e. changes made in the UI
// have no effect.

import { parseCardLabels } from './kanbanLabels';

export function normalizeEpicLabels(raw: string | null | undefined): string | null {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const label of parseCardLabels(raw)) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    labels.push(label);
  }
  return labels.length > 0 ? labels.join(', ') : null;
}

/** Comma-separated labels string for epic form inputs. */
export function labelsFieldFromInput(raw: string | null | undefined): string {
  return parseCardLabels(raw).join(', ');
}

export const DEFAULT_EPIC_COLOR = '#6366F1';

export const EPIC_STATE_LABELS = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
} as const;

export type EpicLifecycleState = keyof typeof EPIC_STATE_LABELS;
export const DEFAULT_EPIC_LIST_STATE_FILTER: EpicLifecycleState = 'in_progress';

export function epicStateLabel(state: string | null | undefined): string {
  return EPIC_STATE_LABELS[(state || '') as EpicLifecycleState] || '';
}

/**
 * Normalize the web form shape into the server's camelCase update body.
 * The PUT /board/epics/:epicId endpoint accepts camelCase keys.
 */
export function epicFormToUpdateBody(form: any) {
  const autonomousOn = form.autonomous ? 1 : 0;
  const rawModel = typeof form.autonomous_model === 'string' ? form.autonomous_model.trim() : '';
  const autonomousModel = autonomousOn ? rawModel || null : null;
  const prTrim = typeof form.pr_base_branch === 'string' ? form.pr_base_branch.trim() : '';
  return {
    name: (form.name || '').trim(),
    description: form.description || '',
    color: form.color || DEFAULT_EPIC_COLOR,
    autonomous: autonomousOn,
    autonomousInterval: form.autonomous_interval || 5,
    autonomousMaxConcurrent: form.autonomous_max_concurrent || 1,
    autonomousModel,
    autonomousSendIt: autonomousOn && form.autonomous_send_it ? 1 : 0,
    prBaseBranch: prTrim || null,
    labels: normalizeEpicLabels(form.labels),
    assignedUserId: form.assigned_user_id || null,
    ...(form.orchestrationBudgets !== undefined
      ? { orchestrationBudgets: form.orchestrationBudgets }
      : {}),
  };
}

/**
 * Filter the epics shown in the board's epic filter dropdown so empty epics
 * (no active / non-Done cards) drop out of the picker. The currently-selected
 * epic is always kept visible even if its active count is 0, so the user can
 * still see and clear the active filter. Mirrors mobile/src/utils/epics.js.
 *
 * @param {Array} epics - epic rows from the board payload
 * @param {(epicId: string) => number} countFor - active card count for an epic
 * @param {string|null} selectedEpicId - the epic currently filtered on, if any
 */
export function epicsWithActiveCards(epics: any, countFor: any, selectedEpicId: any = null) {
  if (!Array.isArray(epics)) return [];
  return epics.filter((e: any) => {
    if (e.id === selectedEpicId) return true;
    if (e.state === 'done') return false;
    if (typeof countFor !== 'function') return true;
    return countFor(e.id) > 0;
  });
}

/**
 * Filter the epics shown in the board's sidebar epic filter (multi-select) so
 * Done epics drop out of the picker. Any epic whose id is in `selectedEpicIds`
 * is always kept visible even when Done, so an active filter chip stays
 * deselectable. Unlike `epicsWithActiveCards` this does not depend on card
 * counts — the sidebar panel only asks "is this epic still active?".
 *
 * @param {Array} epics - epic rows from the board payload (carry `state`)
 * @param {Set<string>|Iterable<string>} selectedEpicIds - currently filtered epic ids
 */
export function nonDoneEpicsForFilter(epics: any, selectedEpicIds: any = new Set()) {
  if (!Array.isArray(epics)) return [];
  const selected =
    selectedEpicIds instanceof Set ? selectedEpicIds : new Set(selectedEpicIds || []);
  return epics.filter((e: any) => e.state !== 'done' || selected.has(e.id));
}

/**
 * POST /board/epics only accepts name, description, color. Autonomous
 * settings are applied via a follow-up PUT if needed.
 */
export function epicFormToCreateBody(form: any) {
  const pr =
    typeof form.pr_base_branch === 'string' && form.pr_base_branch.trim()
      ? form.pr_base_branch.trim()
      : null;
  return {
    name: (form.name || '').trim(),
    description: form.description || '',
    color: form.color || DEFAULT_EPIC_COLOR,
    labels: normalizeEpicLabels(form.labels),
    assignedUserId: form.assigned_user_id || null,
    ...(pr ? { prBaseBranch: pr } : {}),
  };
}

/** Phase autonomous settings use the same camelCase contract as epics. */
export function phaseFormToUpdateBody(form: any) {
  const autonomousOn = form.autonomous ? 1 : 0;
  const rawModel = typeof form.autonomous_model === 'string' ? form.autonomous_model.trim() : '';
  return {
    name: (form.name || '').trim(),
    description: form.description || '',
    autonomous: autonomousOn,
    autonomousInterval: form.autonomous_interval || 5,
    autonomousMaxConcurrent: form.autonomous_max_concurrent || 1,
    autonomousModel: rawModel || null,
    autonomousSendIt: autonomousOn && form.autonomous_send_it ? 1 : 0,
  };
}

export function autonomousModelOptions(modelConfig: any) {
  if (!modelConfig?.engineValidModels) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const models of Object.values(modelConfig.engineValidModels) as any[]) {
    for (const model of models || []) {
      if (!model || seen.has(model)) continue;
      seen.add(model);
      out.push(model);
    }
  }
  return out;
}

export function defaultAutonomousModel(modelConfig: any, opts: any = {}) {
  const options = new Set(autonomousModelOptions(modelConfig));
  const preferredEngine =
    typeof opts.agent?.engine === 'string' && opts.agent.engine.trim()
      ? opts.agent.engine.trim()
      : typeof opts.engine === 'string' && opts.engine.trim()
        ? opts.engine.trim()
        : '';
  const defaults = modelConfig?.engineDefaultModels || {};
  const preferredModels = preferredEngine
    ? modelConfig?.engineValidModels?.[preferredEngine]
    : null;
  const modelAllowedForPreferredEngine = (model: string) => {
    if (!model) return false;
    if (!preferredEngine) return options.has(model);
    return Array.isArray(preferredModels) && preferredModels.includes(model);
  };

  const candidate = typeof opts.model === 'string' ? opts.model.trim() : '';
  if (modelAllowedForPreferredEngine(candidate)) return candidate;

  const agentModel = typeof opts.agent?.model === 'string' ? opts.agent.model.trim() : '';
  if (modelAllowedForPreferredEngine(agentModel)) return agentModel;

  if (preferredEngine) {
    const preferredDefault =
      typeof defaults[preferredEngine] === 'string' ? defaults[preferredEngine].trim() : '';
    if (
      preferredDefault &&
      Array.isArray(preferredModels) &&
      preferredModels.includes(preferredDefault)
    ) {
      return preferredDefault;
    }
  }

  const defaultModel =
    typeof modelConfig?.defaultModel === 'string' ? modelConfig.defaultModel.trim() : '';
  if (defaultModel && options.has(defaultModel)) return defaultModel;

  for (const [engine, models] of Object.entries(modelConfig?.engineValidModels || {}) as any[]) {
    const engineDefault = typeof defaults[engine] === 'string' ? defaults[engine].trim() : '';
    if (engineDefault && Array.isArray(models) && models.includes(engineDefault)) {
      return engineDefault;
    }
  }
  return '';
}
