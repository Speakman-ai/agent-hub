/**
 * QA plan and run lifecycle. Every write to plan status, approval, sign-off,
 * the case list, run status, and results goes through this module, and each
 * one checks the same state rules first.
 *
 * Plan status:
 *   run_started: new | in_progress | done -> in_progress (from done it is a
 *                reopen and clears sign-off)
 *   signed_off:  in_progress -> done
 *
 * Run status: queued -> running -> passed | failed; queued | running ->
 * cancelled. Terminal runs never change, and neither do their results.
 * passed / failed is derived from the recorded verdicts, not supplied.
 *
 * A plan is frozen while it is done or has a queued/running run: no approval
 * change and no case add/edit/remove. Reopen a done plan by starting a run;
 * cancel an active run before editing.
 *
 * Approval is not a status. Any case-list change revokes it and an edit bumps
 * the case version. Sign-off needs current approval, a passed latest run
 * started under that approval, and a pass on every case's current version.
 */
import { randomUUID } from 'crypto';
import { getDb, getStmts } from './db.js';
import type {
  QaCaseRow,
  QaPlanRow,
  QaPlanStatus,
  QaResultRow,
  QaRunRow,
  QaRunScope,
  QaRunStatus,
  QaVerdict,
} from './types.js';

export type QaPlanEvent = 'run_started' | 'signed_off';

export type QaStatusErrorCode =
  | 'not_found'
  | 'illegal_transition'
  | 'not_approved'
  | 'no_cases'
  | 'stale_run'
  | 'plan_done'
  | 'run_active'
  | 'run_not_running'
  | 'not_all_pass';

export class QaStatusError extends Error {
  readonly code: QaStatusErrorCode;
  /** HTTP status a route should answer with. */
  readonly status: 404 | 409;

  constructor(code: QaStatusErrorCode, message: string) {
    super(message);
    this.name = 'QaStatusError';
    this.code = code;
    this.status = code === 'not_found' ? 404 : 409;
  }
}

const TRANSITIONS: Record<QaPlanEvent, Partial<Record<QaPlanStatus, QaPlanStatus>>> = {
  run_started: { new: 'in_progress', in_progress: 'in_progress', done: 'in_progress' },
  signed_off: { in_progress: 'done' },
};

/** Pure transition table. Throws `illegal_transition` for anything not listed. */
export function nextQaPlanStatus(current: QaPlanStatus, event: QaPlanEvent): QaPlanStatus {
  const next = TRANSITIONS[event][current];
  if (!next) {
    throw new QaStatusError('illegal_transition', `Cannot apply ${event} to a ${current} QA plan`);
  }
  return next;
}

function requirePlan(planId: string): QaPlanRow {
  const plan = getStmts().getQaPlan.get(planId);
  if (!plan) throw new QaStatusError('not_found', `QA plan ${planId} not found`);
  return plan;
}

function requireRun(runId: string): QaRunRow {
  const run = getStmts().getQaRun.get(runId);
  if (!run) throw new QaStatusError('not_found', `QA run ${runId} not found`);
  return run;
}

function requireCase(caseId: string): QaCaseRow {
  const qaCase = getStmts().getQaCase.get(caseId);
  if (!qaCase) throw new QaStatusError('not_found', `QA case ${caseId} not found`);
  return qaCase;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<QaRunStatus> = new Set(['queued', 'running']);

/** The plan's queued or running run, if any. Only the latest run can be active. */
function activeRun(planId: string): QaRunRow | undefined {
  const latest = getStmts().getLatestQaRun.get(planId);
  return latest && ACTIVE_RUN_STATUSES.has(latest.status) ? latest : undefined;
}

/** Approval and case-list changes are refused on done plans and during a run. */
function assertPlanEditable(plan: QaPlanRow): void {
  if (plan.status === 'done') {
    throw new QaStatusError('plan_done', 'QA plan is signed off; start a run to reopen it');
  }
  const run = activeRun(plan.id);
  if (run) {
    throw new QaStatusError(
      'run_active',
      `QA run ${run.iteration} is ${run.status}; cancel it first`,
    );
  }
}

/** Lock the case list. Does not change status. Re-approving is a no-op. */
export function approveQaPlan(planId: string, userId: string | null): QaPlanRow {
  return getDb().transaction(() => {
    const plan = requirePlan(planId);
    assertPlanEditable(plan);
    if (plan.approved_at) return plan;
    if (getStmts().countQaCasesByPlan.get(planId)!.n === 0) {
      throw new QaStatusError('no_cases', 'Cannot approve a QA plan with no cases');
    }
    getStmts().setQaPlanApproval.run(userId, planId);
    return requirePlan(planId);
  })();
}

/** Back to draft. Does not change status. */
export function revokeQaPlanApproval(planId: string): QaPlanRow {
  return getDb().transaction(() => {
    assertPlanEditable(requirePlan(planId));
    getStmts().clearQaPlanApproval.run(planId);
    return requirePlan(planId);
  })();
}

export interface QaCaseInput {
  title: string;
  steps?: string;
  expected?: string;
}

/** Append a case to the list. Revokes approval. */
export function addQaCase(planId: string, input: QaCaseInput): QaCaseRow {
  return getDb().transaction(() => {
    const s = getStmts();
    assertPlanEditable(requirePlan(planId));
    const id = randomUUID();
    const position = s.getNextQaCasePosition.get(planId)!.next;
    s.insertQaCase.run(id, planId, position, input.title, input.steps ?? '', input.expected ?? '');
    s.clearQaPlanApproval.run(planId);
    return s.getQaCase.get(id)!;
  })();
}

/**
 * Edit a case: bumps its version, so verdicts recorded against the old text
 * no longer count toward sign-off, and revokes approval.
 */
export function editQaCase(caseId: string, input: Partial<QaCaseInput>): QaCaseRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const current = requireCase(caseId);
    assertPlanEditable(requirePlan(current.plan_id));
    s.updateQaCase.run(
      input.title ?? current.title,
      input.steps ?? current.steps,
      input.expected ?? current.expected,
      caseId,
    );
    s.clearQaPlanApproval.run(current.plan_id);
    return s.getQaCase.get(caseId)!;
  })();
}

/** Remove a case. Revokes approval. */
export function removeQaCase(caseId: string): void {
  getDb().transaction(() => {
    const s = getStmts();
    const current = requireCase(caseId);
    assertPlanEditable(requirePlan(current.plan_id));
    s.deleteQaCase.run(caseId);
    s.clearQaPlanApproval.run(current.plan_id);
  })();
}

/**
 * Queue the next run and move the plan to in_progress. Reopening a done plan
 * clears its sign-off. Refused on unapproved plans and while a run is active.
 */
export function startQaRun(
  planId: string,
  opts: { scope?: QaRunScope; startedBy?: string | null } = {},
): { plan: QaPlanRow; run: QaRunRow } {
  return getDb().transaction(() => {
    const s = getStmts();
    const plan = requirePlan(planId);
    if (!plan.approved_at) {
      throw new QaStatusError('not_approved', 'QA plan must be approved before it can run');
    }
    const active = activeRun(planId);
    if (active) {
      throw new QaStatusError(
        'run_active',
        `QA run ${active.iteration} is already ${active.status}`,
      );
    }
    const next = nextQaPlanStatus(plan.status, 'run_started');
    const runId = randomUUID();
    const iteration = s.getNextQaRunIteration.get(planId)!.next;
    s.insertQaRun.run(
      runId,
      planId,
      iteration,
      opts.scope ?? 'full',
      plan.approval_seq,
      opts.startedBy ?? null,
    );
    if (plan.status === 'done') s.clearQaPlanSignOff.run(planId);
    if (next !== plan.status) s.setQaPlanStatus.run(next, planId);
    return { plan: requirePlan(planId), run: requireRun(runId) };
  })();
}

/** queued -> running, when the executing session picks the run up. */
export function markQaRunRunning(runId: string): QaRunRow {
  return getDb().transaction(() => {
    const run = requireRun(runId);
    if (run.status !== 'queued') {
      throw new QaStatusError('illegal_transition', `Cannot start a ${run.status} QA run`);
    }
    getStmts().setQaRunStatus.run({ status: 'running', id: runId });
    return requireRun(runId);
  })();
}

/**
 * running -> passed | failed. Passed means every recorded verdict is `pass`
 * and, for a full run, every case has one; a failed_only run needs at least
 * one result.
 */
export function finishQaRun(runId: string): QaRunRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const run = requireRun(runId);
    if (run.status !== 'running') {
      throw new QaStatusError('run_not_running', `Cannot finish a ${run.status} QA run`);
    }
    const results = s.listQaResultsByRun.all(runId);
    const covered =
      run.scope === 'full'
        ? s.listQaCasesByPlan.all(run.plan_id).every((c) => results.some((r) => r.case_id === c.id))
        : results.length > 0;
    const passed = covered && results.every((r) => r.verdict === 'pass');
    s.setQaRunStatus.run({ status: passed ? 'passed' : 'failed', id: runId });
    return requireRun(runId);
  })();
}

/** queued | running -> cancelled. */
export function cancelQaRun(runId: string): QaRunRow {
  return getDb().transaction(() => {
    const run = requireRun(runId);
    if (!ACTIVE_RUN_STATUSES.has(run.status)) {
      throw new QaStatusError('illegal_transition', `Cannot cancel a ${run.status} QA run`);
    }
    getStmts().setQaRunStatus.run({ status: 'cancelled', id: runId });
    return requireRun(runId);
  })();
}

export interface QaResultInput {
  verdict: QaVerdict;
  actual?: string;
  notes?: string;
  screenshotArtifactIds?: string[];
  findingCardId?: string | null;
}

/**
 * Record or replace a verdict while the run is running. Finished and
 * cancelled runs are immutable, so evidence behind a sign-off cannot change.
 */
export function recordQaResult(runId: string, caseId: string, input: QaResultInput): QaResultRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const run = requireRun(runId);
    const qaCase = s.getQaCase.get(caseId);
    if (!qaCase || qaCase.plan_id !== run.plan_id) {
      throw new QaStatusError('not_found', `QA case ${caseId} not found in this plan`);
    }
    if (run.status !== 'running') {
      throw new QaStatusError('run_not_running', `QA run ${run.iteration} is ${run.status}`);
    }
    const plan = requirePlan(run.plan_id);
    if (!plan.approved_at || run.approval_seq !== plan.approval_seq) {
      throw new QaStatusError('stale_run', 'QA plan changed since this run started');
    }
    s.upsertQaResult.run(
      randomUUID(),
      runId,
      caseId,
      input.verdict,
      input.actual ?? '',
      input.notes ?? '',
      JSON.stringify(input.screenshotArtifactIds ?? []),
      input.findingCardId ?? null,
    );
    return s.listQaResultsByRun.all(runId).find((r) => r.case_id === caseId)!;
  })();
}

/**
 * Why the plan cannot be signed off, or null when it can. Requires current
 * approval, a latest run that passed under that approval, and a `pass` on
 * every case's current version.
 */
export function qaPlanSignOffBlocker(planId: string): string | null {
  const s = getStmts();
  const plan = requirePlan(planId);
  if (!plan.approved_at) return 'QA plan is not approved';
  const latest = s.getLatestQaRun.get(planId);
  if (!latest) return 'QA plan has no runs';
  if (latest.approval_seq !== plan.approval_seq) {
    return 'QA plan changed since the latest run; start a new run';
  }
  if (latest.status !== 'passed') return `Latest run is ${latest.status}, not passed`;
  const cases = s.listQaCasesByPlan.all(planId);
  if (cases.length === 0) return 'QA plan has no cases';
  const verdicts = new Map(s.listLatestQaVerdictsByPlan.all(planId).map((v) => [v.case_id, v]));
  const failing = cases.filter((c) => {
    const v = verdicts.get(c.id);
    return v?.verdict !== 'pass' || v.case_version !== c.version;
  });
  if (failing.length > 0) {
    return `${failing.length} case(s) without a passing verdict on the current version`;
  }
  return null;
}

/** Human sign-off: in_progress -> done. */
export function signOffQaPlan(planId: string, userId: string | null): QaPlanRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const plan = requirePlan(planId);
    const next = nextQaPlanStatus(plan.status, 'signed_off');
    const blocker = qaPlanSignOffBlocker(planId);
    if (blocker) throw new QaStatusError('not_all_pass', blocker);
    s.setQaPlanSignOff.run(userId, planId);
    s.setQaPlanStatus.run(next, planId);
    return requirePlan(planId);
  })();
}
