// Pure helpers for kanban epic management (web).
// Mirrors mobile/src/utils/epics.js so that web and mobile send the same
// request shape to the server's /board/epics endpoints.
//
// Why this exists: the form state uses snake_case keys for parity with the
// database columns (autonomous_max_concurrent, autonomous_max_iterations,
// autonomous_interval), but the server's PUT route destructures camelCase
// keys (autonomousMaxConcurrent, autonomousMaxIterations, autonomousInterval).
// Without this translation the values arrive as `undefined` on the server and
// the `?? epic.autonomous_max_concurrent` fallback silently preserves the old
// value — i.e. changes made in the UI have no effect.

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
    autonomousMaxIterations: form.autonomous_max_iterations || 3,
    autonomousModel,
    prBaseBranch: prTrim || null,
    ...(form.orchestrationBudgets !== undefined
      ? { orchestrationBudgets: form.orchestrationBudgets }
      : {}),
  };
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
