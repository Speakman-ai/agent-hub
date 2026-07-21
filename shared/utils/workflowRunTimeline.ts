import { orderedStepsFromWorkflow, stepRunMapByStepId } from './workflowProgressDots.js';

export interface WorkflowTimelineRow {
  key: string;
  step: any;
  stepRun: any | null;
  displayStatus: string;
  index: number;
  orphan: boolean;
}

export interface WorkflowRunTimeline {
  rows: WorkflowTimelineRow[];
  totalSteps: number;
  completedSteps: number;
  runningRow: { step: any; stepRun: any; index: number } | null;
  progressPct: number;
}

export function isWorkflowRunActive(run: any): boolean {
  if (!run) return false;
  const s = String(run.status || '').toLowerCase();
  return s === 'pending' || s === 'running';
}

export function isStepTerminalStatus(status: any): boolean {
  const s = String(status || '').toLowerCase();
  return s === 'success' || s === 'error' || s === 'cancelled' || s === 'skipped';
}

/**
 * Merge workflow definition steps with run detail `step_runs` for timeline UI.
 *
 * @param workflow — workflow row with `steps` (from list or GET one)
 * @param stepRuns — `detail.step_runs`
 * @param run — `detail.run`
 */
export function buildWorkflowRunTimeline(
  workflow: any,
  stepRuns: any,
  run: any,
): WorkflowRunTimeline {
  const defSteps = orderedStepsFromWorkflow(workflow || {});
  const byStep = stepRunMapByStepId(stepRuns);
  const runTerminal = Boolean(run && !isWorkflowRunActive(run));

  const rows: WorkflowTimelineRow[] = defSteps.map((step: any, index: number) => {
    const sid = String(step.id ?? '');
    const sr = sid ? byStep.get(sid) : undefined;
    const displayStatus = sr
      ? String(sr.status || 'pending').toLowerCase()
      : runTerminal
        ? 'not_run'
        : 'queued';
    return {
      key: sid || `idx-${index}`,
      step,
      stepRun: sr || null,
      displayStatus,
      index,
      orphan: false,
    };
  });

  const seen = new Set(defSteps.map((s: any) => String(s.id ?? '')));
  const orphans: WorkflowTimelineRow[] = [];
  for (const sr of stepRuns || []) {
    const sid = String(sr.workflow_step_id || '');
    if (!sid || seen.has(sid)) continue;
    seen.add(sid);
    const displayStatus = String(sr.status || 'pending').toLowerCase();
    orphans.push({
      key: sid,
      step: {
        id: sid,
        title: sr.step_title || 'Step',
        step_order: sr.step_order ?? 999,
      },
      stepRun: sr,
      displayStatus,
      index: 0,
      orphan: true,
    });
  }
  orphans.sort((a: any, b: any) => (a.step.step_order ?? 0) - (b.step.step_order ?? 0));
  rows.push(...orphans);
  rows.forEach((r, i) => {
    r.index = i;
  });

  let completedSteps = 0;
  for (const r of rows) {
    if (r.stepRun && isStepTerminalStatus(String(r.stepRun.status || '').toLowerCase())) {
      completedSteps += 1;
    }
  }

  const runningEntry = rows.find(
    (r) => r.stepRun && String(r.stepRun.status || '').toLowerCase() === 'running',
  );
  const runningRow = runningEntry
    ? { step: runningEntry.step, stepRun: runningEntry.stepRun, index: runningEntry.index }
    : null;

  const denom = Math.max(1, rows.length);
  const progressPct = Math.min(100, Math.round((completedSteps / denom) * 100));

  return {
    rows,
    totalSteps: rows.length,
    completedSteps,
    runningRow,
    progressPct,
  };
}
