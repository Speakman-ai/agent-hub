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

export const DEFAULT_EPIC_COLOR = '#6366F1';

/**
 * Normalize the web form shape into the server's camelCase update body.
 * The PUT /board/epics/:epicId endpoint accepts camelCase keys.
 */
export function epicFormToUpdateBody(form) {
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
    autonomousMaxConcurrent: form.autonomous_max_concurrent || 2,
    autonomousModel,
    autonomousSendIt: autonomousOn && form.autonomous_send_it ? 1 : 0,
    prBaseBranch: prTrim || null,
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
export function epicsWithActiveCards(epics, countFor, selectedEpicId = null) {
  if (!Array.isArray(epics)) return [];
  if (typeof countFor !== 'function') return epics;
  return epics.filter((e) => e.id === selectedEpicId || countFor(e.id) > 0);
}

/**
 * POST /board/epics only accepts name, description, color. Autonomous
 * settings are applied via a follow-up PUT if needed.
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
