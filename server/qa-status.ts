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
 * cancelled. passed / failed is derived from the recorded verdicts, not
 * supplied. The agent cannot change a finished run's results; a person can
 * override one verdict at a time (`overrideQaResult`), which re-derives
 * passed / failed. Cancelled runs never change.
 *
 * Each run fixes its in-scope case ids when it is queued: every case for
 * `full`, and for `failed_only` every case without a `pass` on its current
 * version. A run finishes on its own once every in-scope case has a result.
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
import type { QaAutoRerunTrigger } from './qa-schema.js';
import type {
  QaCaseRow,
  QaLatestVerdictRow,
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
  | 'run_not_finished'
  | 'not_all_pass'
  | 'invalid_order'
  | 'edit_conflict'
  | 'nothing_to_rerun'
  | 'out_of_scope'
  | 'artifact_not_owned';

export class QaStatusError extends Error {
  readonly code: QaStatusErrorCode;
  /** HTTP status a route should answer with. */
  readonly status: 400 | 404 | 409;
  /** Extra fields for the error response body. */
  readonly details?: Record<string, unknown>;

  constructor(code: QaStatusErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'QaStatusError';
    this.code = code;
    this.details = details;
    this.status =
      code === 'not_found'
        ? 404
        : code === 'invalid_order' || code === 'artifact_not_owned'
          ? 400
          : 409;
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

export interface QaPlanPatch {
  title?: string;
  goal?: string;
  targetUrl?: string;
  epicId?: string | null;
  cardId?: string | null;
  deployEnvironment?: string | null;
  autoRerun?: boolean;
  maxIterations?: number;
  autoRerunTrigger?: QaAutoRerunTrigger;
  autoRerunBranch?: string | null;
  autoRerunDelayMinutes?: number;
}

/**
 * Edit plan fields. The target URL is what the run evidence was gathered
 * against, so changing it follows the case-list rules (frozen while done or
 * running, revokes approval). The other fields are labels and rerun settings
 * and can change at any time.
 */
export function updateQaPlan(planId: string, patch: QaPlanPatch): QaPlanRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const plan = requirePlan(planId);
    const targetChanged = patch.targetUrl !== undefined && patch.targetUrl !== plan.target_url;
    if (targetChanged) assertPlanEditable(plan);
    s.updateQaPlan.run({
      id: planId,
      title: patch.title ?? plan.title,
      goal: patch.goal ?? plan.goal,
      target_url: patch.targetUrl ?? plan.target_url,
      epic_id: patch.epicId !== undefined ? patch.epicId : plan.epic_id,
      card_id: patch.cardId !== undefined ? patch.cardId : plan.card_id,
      deploy_environment:
        patch.deployEnvironment !== undefined ? patch.deployEnvironment : plan.deploy_environment,
      auto_rerun: patch.autoRerun !== undefined ? (patch.autoRerun ? 1 : 0) : plan.auto_rerun,
      max_iterations: patch.maxIterations ?? plan.max_iterations,
      auto_rerun_trigger: patch.autoRerunTrigger ?? plan.auto_rerun_trigger,
      auto_rerun_branch:
        patch.autoRerunBranch !== undefined ? patch.autoRerunBranch : plan.auto_rerun_branch,
      auto_rerun_delay_minutes: patch.autoRerunDelayMinutes ?? plan.auto_rerun_delay_minutes,
    });
    if (targetChanged) s.clearQaPlanApproval.run(planId);
    return requirePlan(planId);
  })();
}

/** Delete a plan and its history. Refused while a run is queued or running. */
export function deleteQaPlan(planId: string): void {
  getDb().transaction(() => {
    requirePlan(planId);
    const run = activeRun(planId);
    if (run) {
      throw new QaStatusError(
        'run_active',
        `QA run ${run.iteration} is ${run.status}; cancel it first`,
      );
    }
    getStmts().deleteQaPlan.run(planId);
  })();
}

/**
 * Reorder the case list. `orderedIds` must name every case exactly once.
 * Order does not change what is tested, so approval is kept, but the list is
 * still frozen while done or running.
 */
export function reorderQaCases(planId: string, orderedIds: string[]): QaCaseRow[] {
  return getDb().transaction(() => {
    const s = getStmts();
    assertPlanEditable(requirePlan(planId));
    const current = s.listQaCasesByPlan.all(planId);
    const known = new Set(current.map((c) => c.id));
    if (
      orderedIds.length !== current.length ||
      new Set(orderedIds).size !== orderedIds.length ||
      !orderedIds.every((id) => known.has(id))
    ) {
      throw new QaStatusError('invalid_order', 'orderedIds must list every case in the plan once');
    }
    orderedIds.forEach((id, i) => s.setQaCasePosition.run(i, id));
    return s.listQaCasesByPlan.all(planId);
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

export type QaCaseField = 'title' | 'steps' | 'expected';

/**
 * Fields whose saved value moved away from the text the edit was made against
 * and does not already equal the new value. Pure.
 */
export function qaCaseEditConflicts(
  current: Pick<QaCaseRow, QaCaseField>,
  input: Partial<QaCaseInput>,
  expectedBase: Partial<Record<QaCaseField, string>>,
): QaCaseField[] {
  return (Object.keys(expectedBase) as QaCaseField[]).filter((field) => {
    const base = expectedBase[field];
    const next = input[field];
    return (
      base !== undefined && next !== undefined && current[field] !== base && current[field] !== next
    );
  });
}

/**
 * Edit a case: bumps its version, so verdicts recorded against the old text
 * no longer count toward sign-off, and revokes approval.
 *
 * `expectedBase` makes the edit conditional: for each listed field, the saved
 * value must still be the text the caller edited (or already equal the new
 * value). The check and the write share one transaction, so an edit made
 * against stale text is refused with `edit_conflict` instead of overwriting a
 * change the caller never saw. Without it the edit is unconditional.
 */
export function editQaCase(
  caseId: string,
  input: Partial<QaCaseInput>,
  expectedBase?: Partial<Record<QaCaseField, string>>,
): QaCaseRow {
  return getDb().transaction(() => {
    const s = getStmts();
    const current = requireCase(caseId);
    assertPlanEditable(requirePlan(current.plan_id));
    const conflicts = expectedBase ? qaCaseEditConflicts(current, input, expectedBase) : [];
    if (conflicts.length > 0) {
      throw new QaStatusError(
        'edit_conflict',
        `QA case changed since it was edited: ${conflicts.join(', ')}`,
        {
          conflicts,
          case: { title: current.title, steps: current.steps, expected: current.expected },
        },
      );
    }
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
    const scope = opts.scope ?? 'full';
    const caseIds = qaRunScopeCaseIds(planId, scope);
    if (caseIds.length === 0) {
      throw new QaStatusError(
        'nothing_to_rerun',
        'Every case already passed on its current version; start a full run instead',
      );
    }
    const next = nextQaPlanStatus(plan.status, 'run_started');
    const runId = randomUUID();
    const iteration = s.getNextQaRunIteration.get(planId)!.next;
    s.insertQaRun.run(
      runId,
      planId,
      iteration,
      scope,
      plan.approval_seq,
      opts.startedBy ?? null,
      JSON.stringify(caseIds),
    );
    if (plan.status === 'done') s.clearQaPlanSignOff.run(planId);
    if (next !== plan.status) s.setQaPlanStatus.run(next, planId);
    return { plan: requirePlan(planId), run: requireRun(runId) };
  })();
}

/**
 * Case ids a new run of `scope` would cover, in case order. `failed_only`
 * picks every case whose latest verdict is missing, not `pass`, or recorded
 * against an older version of the case.
 */
export function qaRunScopeCaseIds(
  planId: string,
  scope: QaRunScope,
  beforeIteration?: number,
): string[] {
  const s = getStmts();
  const cases = s.listQaCasesByPlan.all(planId);
  if (scope === 'full') return cases.map((c) => c.id);
  const verdicts =
    beforeIteration === undefined
      ? s.listLatestQaVerdictsByPlan.all(planId)
      : (getDb()
          .prepare(
            `SELECT case_id, case_version, verdict FROM (
               SELECT r.case_id, r.case_version, r.verdict,
                      ROW_NUMBER() OVER (PARTITION BY r.case_id ORDER BY u.iteration DESC) AS rn
                 FROM qa_results r
                 JOIN qa_runs u ON u.id = r.run_id
                WHERE u.plan_id = ? AND u.status <> 'cancelled' AND u.iteration < ?
             ) WHERE rn = 1`,
          )
          .all(planId, beforeIteration) as Array<
          Pick<QaLatestVerdictRow, 'case_id' | 'case_version' | 'verdict'>
        >);
  const latest = new Map(verdicts.map((v) => [v.case_id, v]));
  return cases
    .filter((c) => {
      const v = latest.get(c.id);
      return v?.verdict !== 'pass' || v.case_version !== c.version;
    })
    .map((c) => c.id);
}

/**
 * The run's in-scope case ids. Rows from before scope was recorded have no
 * `case_ids`, so their scope is rebuilt as it would have been at queue time:
 * every case for `full`; for `failed_only`, the cases without a pass on their
 * current version in earlier runs (the case list is frozen while a run is
 * active, so current versions are the queue-time ones), plus any case the run
 * already has a result for. An empty rebuild falls back to every case, so a
 * legacy run never rejects all results.
 */
export function qaRunCaseIds(run: QaRunRow): string[] {
  if (run.case_ids !== null) {
    try {
      const v: unknown = JSON.parse(run.case_ids);
      if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
    } catch {
      /* fall through to the derived scope */
    }
  }
  const s = getStmts();
  const cases = s.listQaCasesByPlan.all(run.plan_id);
  if (run.scope === 'full') return cases.map((c) => c.id);
  // Decide the empty-rebuild fallback before adding recorded results, so the
  // scope cannot shrink to the recorded subset once the first result lands.
  const rebuilt = qaRunScopeCaseIds(run.plan_id, 'failed_only', run.iteration);
  if (rebuilt.length === 0) return cases.map((c) => c.id);
  const scope = new Set(rebuilt);
  for (const r of s.listQaResultsByRun.all(run.id)) scope.add(r.case_id);
  return cases.filter((c) => scope.has(c.id)).map((c) => c.id);
}

/**
 * queued -> running, when the executing session picks the run up. Already
 * running is a no-op, since the server begins a run when it seeds the session.
 */
export function markQaRunRunning(runId: string): QaRunRow {
  return getDb().transaction(() => {
    const run = requireRun(runId);
    if (run.status === 'running') return run;
    if (run.status !== 'queued') {
      throw new QaStatusError('illegal_transition', `Cannot start a ${run.status} QA run`);
    }
    getStmts().setQaRunStatus.run({ status: 'running', id: runId });
    return requireRun(runId);
  })();
}

/** Whether every in-scope case has a result, and whether all of them pass. */
function qaRunCoverage(run: QaRunRow): { covered: boolean; passed: boolean } {
  const scope = qaRunCaseIds(run);
  const verdicts = new Map(
    getStmts()
      .listQaResultsByRun.all(run.id)
      .map((r) => [r.case_id, r.verdict]),
  );
  const covered = scope.length > 0 && scope.every((id) => verdicts.has(id));
  return { covered, passed: covered && scope.every((id) => verdicts.get(id) === 'pass') };
}

/**
 * running -> passed | failed. Passed means every in-scope case has a result
 * and every one of them is `pass`; finishing early with cases missing fails.
 */
export function finishQaRun(runId: string): QaRunRow {
  return getDb().transaction(() => {
    const run = requireRun(runId);
    if (run.status !== 'running') {
      throw new QaStatusError('run_not_running', `Cannot finish a ${run.status} QA run`);
    }
    const { passed } = qaRunCoverage(run);
    getStmts().setQaRunStatus.run({ status: passed ? 'passed' : 'failed', id: runId });
    return requireRun(runId);
  })();
}

/**
 * Finish a running run once every in-scope case has a result. Returns the
 * finished run, or null while cases are still missing (or the run is no
 * longer running).
 */
export function completeQaRunIfCovered(runId: string): QaRunRow | null {
  return getDb().transaction(() => {
    const run = requireRun(runId);
    if (run.status !== 'running') return null;
    const { covered, passed } = qaRunCoverage(run);
    if (!covered) return null;
    getStmts().setQaRunStatus.run({ status: passed ? 'passed' : 'failed', id: runId });
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

/**
 * Ids from `ids` that are not artifacts of `sessionId`. A run's screenshots
 * must come from its own session: the plan detail opens them through that
 * session's artifact routes, and an id from any other session would either
 * not resolve or expose a document the run never produced.
 */
export function unownedQaArtifactIds(ids: string[], sessionId: string | null): string[] {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (!sessionId) return unique;
  const owned = new Set(
    (
      getDb()
        .prepare(
          `SELECT id FROM artifacts WHERE session_id = ? AND id IN (${unique.map(() => '?').join(',')})`,
        )
        .all(sessionId, ...unique) as Array<{ id: string }>
    ).map((r) => r.id),
  );
  return unique.filter((id) => !owned.has(id));
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
    if (!qaRunCaseIds(run).includes(caseId)) {
      throw new QaStatusError('out_of_scope', `QA case ${caseId} is not in this run's scope`);
    }
    const plan = requirePlan(run.plan_id);
    if (!plan.approved_at || run.approval_seq !== plan.approval_seq) {
      throw new QaStatusError('stale_run', 'QA plan changed since this run started');
    }
    const screenshots = [...new Set(input.screenshotArtifactIds ?? [])];
    const unowned = unownedQaArtifactIds(screenshots, run.session_id);
    if (unowned.length > 0) {
      throw new QaStatusError(
        'artifact_not_owned',
        `Screenshot artifact(s) not uploaded by this run's session: ${unowned.join(', ')}`,
        { artifactIds: unowned },
      );
    }
    s.upsertQaResult.run(
      randomUUID(),
      runId,
      caseId,
      input.verdict,
      input.actual ?? '',
      input.notes ?? '',
      JSON.stringify(screenshots),
      input.findingCardId ?? null,
    );
    return s.listQaResultsByRun.all(runId).find((r) => r.case_id === caseId)!;
  })();
}

export interface QaResultOverrideOutcome {
  result: QaResultRow;
  run: QaRunRow;
  /** The run moved between passed and failed. */
  runStatusChanged: boolean;
  /** The verdict before this call. */
  previousVerdict: QaVerdict;
}

/**
 * A person's verdict for one result of a finished (passed / failed) run, for
 * when the agent judged a case wrong. The agent's verdict is kept in
 * `original_verdict`; overriding back to it clears the override. The run's
 * passed / failed status is re-derived from the new verdicts, so a failed run
 * whose only failure was overridden to pass becomes passed and the plan can be
 * signed off. Refused on a signed-off plan: start a run to reopen it.
 */
export function overrideQaResult(
  runId: string,
  caseId: string,
  verdict: QaVerdict,
  userId: string | null,
): QaResultOverrideOutcome {
  return getDb().transaction(() => {
    const s = getStmts();
    const run = requireRun(runId);
    const result = s.listQaResultsByRun.all(runId).find((r) => r.case_id === caseId);
    if (!result)
      throw new QaStatusError('not_found', `No result for QA case ${caseId} in this run`);
    if (run.status !== 'passed' && run.status !== 'failed') {
      throw new QaStatusError(
        'run_not_finished',
        `QA run ${run.iteration} is ${run.status}; only a finished run's verdicts can be overridden`,
      );
    }
    if (requirePlan(run.plan_id).status === 'done') {
      throw new QaStatusError('plan_done', 'QA plan is signed off; start a run to reopen it');
    }
    const previousVerdict = result.verdict;
    if (verdict !== previousVerdict) {
      const original = result.original_verdict ?? result.verdict;
      const reverting = verdict === original;
      s.setQaResultOverride.run({
        id: result.id,
        verdict,
        original_verdict: reverting ? null : original,
        overridden_by: reverting ? null : userId,
      });
    }
    const { passed } = qaRunCoverage(run);
    const status: QaRunStatus = passed ? 'passed' : 'failed';
    if (status !== run.status) s.setQaRunFinishedStatus.run(status, runId);
    return {
      result: s.listQaResultsByRun.all(runId).find((r) => r.case_id === caseId)!,
      run: requireRun(runId),
      runStatusChanged: status !== run.status,
      previousVerdict,
    };
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
