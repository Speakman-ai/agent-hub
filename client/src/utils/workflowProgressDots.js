/**
 * Pure helpers for Hub workflow list — map definition steps + latest run step_runs
 * to a stable ordered list for progress-dot rendering.
 */

export function orderedStepsFromWorkflow(workflow) {
  const steps = Array.isArray(workflow?.steps) ? [...workflow.steps] : [];
  steps.sort((a, b) => (a.step_order ?? 0) - (b.step_order ?? 0));
  return steps;
}

export function stepRunMapByStepId(stepRuns) {
  const m = new Map();
  for (const sr of stepRuns || []) {
    const sid = sr?.workflow_step_id;
    if (sid) m.set(String(sid), sr);
  }
  return m;
}

/**
 * @typedef {'inactive'|'pending'|'running'|'success'|'error'|'cancelled'|'skipped'} WorkflowDotKind
 */

/**
 * @param {object} workflow — API workflow row with `steps`
 * @param {object[]|null|undefined} stepRuns — from GET …/runs/:runId
 * @param {boolean} hasRun — whether a parent run exists (even with empty step_runs)
 * @returns {{ id: string, title: string, kind: WorkflowDotKind }[]}
 */
export function buildWorkflowStepDots(workflow, stepRuns, hasRun) {
  const steps = orderedStepsFromWorkflow(workflow);
  const byStep = stepRunMapByStepId(stepRuns);
  return steps.map((s) => {
    const id = String(s.id ?? '');
    const run = id ? byStep.get(id) : undefined;
    const kind = dotKindForStep(run, hasRun);
    return {
      id: id || `idx-${s.step_order}`,
      title: String(s.title || 'Step'),
      kind,
    };
  });
}

/**
 * @param {object|undefined} stepRun
 * @param {boolean} hasRun
 * @returns {WorkflowDotKind}
 */
export function dotKindForStep(stepRun, hasRun) {
  if (!hasRun) return 'inactive';
  if (!stepRun) return 'pending';
  const st = String(stepRun.status || '').toLowerCase();
  if (st === 'success') return 'success';
  if (st === 'error') return 'error';
  if (st === 'cancelled') return 'cancelled';
  if (st === 'skipped') return 'skipped';
  if (st === 'running') return 'running';
  return 'pending';
}
