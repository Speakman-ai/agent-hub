// Pure helpers for kanban epic management (mobile).
// Mirrors the semantics of client/src/components/KanbanBoard.jsx so that web
// and mobile agree on what "autonomous", "card count", and filtering mean.
import { parseCardLabels } from './kanbanLabels';

/** Dedupe (case-insensitive) a comma-separated labels field into the server's
 * canonical `a, b, c` string, or null when empty. Mirrors the web helper. */
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
// Same palette as the web EPIC_COLORS constant.
export const EPIC_COLORS = [
  '#6366F1', // indigo
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#EF4444', // red
  '#F97316', // orange
  '#EAB308', // yellow
  '#22C55E', // green
  '#06B6D4', // cyan
  '#3B82F6', // blue
];
export const DEFAULT_EPIC_COLOR = '#6366F1';
export const EPIC_STATE_LABELS: Record<string, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  done: 'Done',
};
export const DEFAULT_EPIC_LIST_STATE_FILTER = 'in_progress';
export function epicStateLabel(state: string | null | undefined): string {
  return EPIC_STATE_LABELS[state || ''] || '';
}
export function featureBranchNameFromName(name: string | null | undefined): string {
  const rawSlug = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const slug = rawSlug.slice(0, 72).replace(/-+$/g, '') || 'feature';
  return `feature/${slug}`;
}
export function nextFeatureBranch(current: string | null | undefined, name: string): string {
  const trimmed = typeof current === 'string' ? current.trim() : '';
  return trimmed || featureBranchNameFromName(name);
}
export function epicBranchTogglePatch(form: any, enabled: boolean) {
  return {
    pr_base_branch: enabled ? nextFeatureBranch(form.pr_base_branch, form.name) : '',
  };
}
export const DEFAULT_EPIC_FORM: Record<string, any> = {
  name: '',
  description: '',
  color: DEFAULT_EPIC_COLOR,
  labels: '',
  assigned_user_id: '',
  pr_base_branch: '',
  autonomous: 0,
  autonomous_interval: 5,
  autonomous_max_concurrent: 1,
  autonomous_model: '',
  autonomous_send_it: 0,
};
/**
 * Build an edit form from an existing epic row, falling back to defaults for
 * fields that the server may not have populated.
 */
export function epicFormFromRow(epic: any) {
  if (!epic) return { ...DEFAULT_EPIC_FORM };
  return {
    name: epic.name || '',
    description: epic.description || '',
    color: epic.color || DEFAULT_EPIC_COLOR,
    labels: labelsFieldFromInput(epic.labels),
    assigned_user_id: epic.assigned_user_id || '',
    autonomous: epic.autonomous ? 1 : 0,
    autonomous_interval: epic.autonomous_interval || 5,
    autonomous_max_concurrent: epic.autonomous_max_concurrent || 1,
    autonomous_model: epic.autonomous_model || '',
    autonomous_send_it: epic.autonomous_send_it === 0 ? 0 : 1,
    pr_base_branch: epic.pr_base_branch || '',
  };
}
/**
 * Normalize the mobile form shape into the server's camelCase update body.
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
 * POST /board/epics only requires a subset of the form — name, description,
 * color. Autonomous settings are applied via a follow-up PUT if needed.
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
/**
 * Sentinel epic-filter value meaning "cards with no epic". Not a real epic id
 * (real ids are UUIDs), so it never collides. Mirrors client/src/utils/epics.ts.
 */
export const NO_EPIC_FILTER_ID = '__no_epic__';

/**
 * Filter cards by epic id. A null/undefined filter returns all cards. The
 * NO_EPIC_FILTER_ID sentinel returns only cards with no epic. Used by the
 * board-level epic dropdown.
 */
export function filterCardsByEpic(cards: any, epicId: any) {
  if (!Array.isArray(cards)) return [];
  if (!epicId) return cards;
  if (epicId === NO_EPIC_FILTER_ID) return cards.filter((c: any) => !c.epic_id);
  return cards.filter((c: any) => c.epic_id === epicId);
}
/**
 * Count the cards belonging to a given epic that are not yet "done".
 * The web board passes a set of done-column ids; we do the same here so
 * the count mirrors what the web dropdown shows.
 */
export function countOpenCardsForEpic(cards: any, epicId: any, doneColumnIds: any = new Set()) {
  if (!Array.isArray(cards) || !epicId) return 0;
  const done = doneColumnIds instanceof Set ? doneColumnIds : new Set(doneColumnIds || []);
  return cards.filter((c: any) => c.epic_id === epicId && !done.has(c.column_id)).length;
}
/**
 * Filter the epics shown in the board's epic filter dropdown so empty epics
 * (no active / non-Done cards) drop out of the picker. The currently-selected
 * epic is always kept visible even if its active count is 0, so the user can
 * still see and clear the active filter. Mirrors client/src/utils/epics.js.
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
 * Convenience — find an epic by id inside the board payload's `epics` array.
 */
export function findEpic(epics: any, epicId: any) {
  if (!Array.isArray(epics) || !epicId) return null;
  return epics.find((e: any) => e.id === epicId) || null;
}
export function epicDropdownLabel(epic: any) {
  if (!epic) return '';
  return epic.name;
}
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
export function defaultAutonomousModel(modelConfig: any) {
  const defaults = modelConfig?.engineDefaultModels || {};
  for (const [engine, models] of Object.entries(modelConfig?.engineValidModels || {}) as any[]) {
    const engineDefault = typeof defaults[engine] === 'string' ? defaults[engine].trim() : '';
    if (engineDefault && Array.isArray(models) && models.includes(engineDefault))
      return engineDefault;
  }
  return autonomousModelOptions(modelConfig)[0] || '';
}
