// Pure helpers for kanban epic management (mobile).
// Mirrors the semantics of client/src/components/KanbanBoard.jsx so that web
// and mobile agree on what "autonomous", "card count", and filtering mean.

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

export const DEFAULT_EPIC_FORM = {
  name: '',
  description: '',
  color: DEFAULT_EPIC_COLOR,
  pr_base_branch: '',
  autonomous: 0,
  autonomous_interval: 5,
  autonomous_max_concurrent: 2,
  autonomous_max_iterations: 3,
  autonomous_model: '',
};

/**
 * Build an edit form from an existing epic row, falling back to defaults for
 * fields that the server may not have populated.
 */
export function epicFormFromRow(epic) {
  if (!epic) return { ...DEFAULT_EPIC_FORM };
  return {
    name: epic.name || '',
    description: epic.description || '',
    color: epic.color || DEFAULT_EPIC_COLOR,
    autonomous: epic.autonomous ? 1 : 0,
    autonomous_interval: epic.autonomous_interval || 5,
    autonomous_max_concurrent: epic.autonomous_max_concurrent || 2,
    autonomous_max_iterations: epic.autonomous_max_iterations || 3,
    autonomous_model: epic.autonomous_model || '',
    pr_base_branch: epic.pr_base_branch || '',
  };
}

/**
 * Normalize the mobile form shape into the server's camelCase update body.
 * The PUT /board/epics/:epicId endpoint accepts camelCase keys.
 */
export function epicFormToUpdateBody(form) {
  const autonomousOn = form.autonomous ? 1 : 0;
  const rawModel =
    typeof form.autonomous_model === 'string' ? form.autonomous_model.trim() : '';
  const autonomousModel = autonomousOn ? (rawModel || null) : null;
  const prTrim =
    typeof form.pr_base_branch === 'string' ? form.pr_base_branch.trim() : '';
  return {
    name: (form.name || '').trim(),
    description: form.description || '',
    color: form.color || DEFAULT_EPIC_COLOR,
    autonomous: autonomousOn,
    autonomousInterval: form.autonomous_interval || 5,
    autonomousMaxConcurrent: form.autonomous_max_concurrent || 2,
    autonomousMaxIterations: form.autonomous_max_iterations || 3,
    autonomousModel,
    prBaseBranch: prTrim || null,
  };
}

/**
 * POST /board/epics only requires a subset of the form — name, description,
 * color. Autonomous settings are applied via a follow-up PUT if needed.
 */
export function epicFormToCreateBody(form) {
  const pr =
    typeof form.pr_base_branch === 'string' && form.pr_base_branch.trim()
      ? form.pr_base_branch.trim()
      : null;
  return {
    name: (form.name || '').trim(),
    description: form.description || '',
    color: form.color || DEFAULT_EPIC_COLOR,
    ...(pr ? { prBaseBranch: pr } : {}),
  };
}

/**
 * Filter cards by epic id. A null/undefined filter returns all cards.
 * Used by the board-level epic dropdown.
 */
export function filterCardsByEpic(cards, epicId) {
  if (!Array.isArray(cards)) return [];
  if (!epicId) return cards;
  return cards.filter((c) => c.epic_id === epicId);
}

/**
 * Count the cards belonging to a given epic that are not yet "done".
 * The web board passes a set of done-column ids; we do the same here so
 * the count mirrors what the web dropdown shows.
 */
export function countOpenCardsForEpic(cards, epicId, doneColumnIds = new Set()) {
  if (!Array.isArray(cards) || !epicId) return 0;
  const done = doneColumnIds instanceof Set ? doneColumnIds : new Set(doneColumnIds || []);
  return cards.filter((c) => c.epic_id === epicId && !done.has(c.column_id)).length;
}

/**
 * Convenience — find an epic by id inside the board payload's `epics` array.
 */
export function findEpic(epics, epicId) {
  if (!Array.isArray(epics) || !epicId) return null;
  return epics.find((e) => e.id === epicId) || null;
}

/**
 * The web board auto-prepends a "⚡" glyph to the currently-autonomous epic
 * in its dropdown. Replicate the same label here for parity.
 */
export function epicDropdownLabel(epic) {
  if (!epic) return '';
  const zap = epic.autonomous ? '\u26A1 ' : '';
  return `${zap}${epic.name}`;
}
