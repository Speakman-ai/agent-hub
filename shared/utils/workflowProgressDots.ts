/**
 * Pure helpers for Hub workflow list — map definition steps + latest run step_runs
 * to a stable ordered list for progress-dot rendering.
 *
 * Consumed by both web (`ProjectWorkflowsPage`, `WorkflowRunsSection`) and mobile
 * (`WorkflowsScreen`) so the timeline logic never drifts between surfaces.
 */

export type WorkflowDotKind =
  | 'inactive'
  | 'pending'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'skipped';

export interface WorkflowStepDot {
  id: string;
  title: string;
  kind: WorkflowDotKind;
}

export function orderedStepsFromWorkflow(workflow: any): any[] {
  const steps = Array.isArray(workflow?.steps) ? [...workflow.steps] : [];
  steps.sort((a: any, b: any) => (a.step_order ?? 0) - (b.step_order ?? 0));
  return steps;
}

export function stepRunMapByStepId(stepRuns: any): Map<string, any> {
  const m = new Map<string, any>();
  for (const sr of stepRuns || []) {
    const sid = sr?.workflow_step_id;
    if (sid) m.set(String(sid), sr);
  }
  return m;
}

export function buildWorkflowStepDots(
  workflow: any,
  stepRuns: any,
  hasRun: any,
): WorkflowStepDot[] {
  const steps = orderedStepsFromWorkflow(workflow);
  const byStep = stepRunMapByStepId(stepRuns);
  return steps.map((s: any) => {
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

export function dotKindForStep(stepRun: any, hasRun: any): WorkflowDotKind {
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
