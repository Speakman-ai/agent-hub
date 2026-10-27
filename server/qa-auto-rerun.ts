/**
 * QA auto-rerun: restart a plan's loop once the fixes for its latest run have
 * reached the target.
 *
 * The latest run must have failed, under the plan's current approval, with a
 * finding card on every fail / needs_change result. Once every one of those
 * cards is Done, the plan's trigger decides when the failed cases rerun:
 *   - `deployment`: after a successful deployment to the linked environment
 *     that was triggered at or after the last card reached Done, so its ref can
 *     contain the fixes;
 *   - `merge`: after a pull request is merged into the chosen branch, at or
 *     after the last card reached Done (less a short grace, since a merge moves
 *     its own card to Done a moment after it lands). The latest merge inside
 *     that grace is taken as the one carrying the last fix. Then the optional delay
 *     that gives the branch's own deploy time to finish.
 * With no environment / branch set, nothing says when the fixes reach the
 * target, so the plan does not rerun. The owner gets an inbox notice instead.
 * A failed run at `max_iterations` stops the loop and notifies the owner.
 * Manual reruns ignore all of this.
 *
 * Each notice and each rerun happens at most once per run: the run's
 * `auto_rerun_state` is claimed with a conditional UPDATE before acting. A
 * manual-rerun notice can still be followed by a rerun if an environment is
 * linked afterwards, and a cap notice by a notice or rerun if the owner raises
 * `max_iterations`. Lowering the cap onto the current run after a manual
 * notice or a failed rerun still sends the cap notice. Every claim follows a
 * fresh evaluation against the current settings.
 *
 * Triggers: every `kanban_update` / `deployment_update` / PR merge / plan
 * update broadcast schedules a debounced sweep of that project's plans, a
 * pending merge delay schedules a sweep for when it ends, and the server sweeps
 * every project once at boot for events missed while down.
 */
import { getDb, getStmts } from './db.js';
import { isColumnDone } from './kanban-blockers.js';
import { QA_ATTENTION_EVENT } from './qa-attention-event.js';
import { launchQaRun, type QaRunLaunchDeps } from './qa-run-launch.js';
import { QaStatusError } from './qa-status.js';
import type { QaPlanRow, QaRunRow } from './types.js';

export const QA_AUTO_RERUN_STATES = [
  'cap_notified',
  'manual_notified',
  'rerun_started',
  'rerun_failed',
] as const;
export type QaAutoRerunState = (typeof QA_AUTO_RERUN_STATES)[number];

export { QA_ATTENTION_EVENT };

/** How long before the last fix reached Done a merge still counts as carrying it. */
export const QA_MERGE_GRACE_MS = 5 * 60_000;

export type QaAutoRerunDecision =
  | { kind: 'idle'; reason: string }
  | { kind: 'wait_fixes'; run: QaRunRow; pending: number }
  | { kind: 'cap_reached'; run: QaRunRow }
  | { kind: 'notify_manual'; run: QaRunRow; cardIds: string[] }
  | { kind: 'wait_deploy'; run: QaRunRow; environment: string; fixesDoneAt: string }
  | { kind: 'wait_merge'; run: QaRunRow; branch: string }
  | { kind: 'wait_delay'; run: QaRunRow; branch: string; dueAt: number }
  | { kind: 'rerun'; run: QaRunRow; target: string };

/** SQLite `datetime('now')` text (UTC, no zone) or ISO text to epoch ms. */
function timestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const ms = Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(iso) ? iso : `${iso}Z`);
  return Number.isFinite(ms) ? ms : 0;
}

interface FindingCardState {
  card_id: string | null;
  board_project_id: string | null;
  column_name: string | null;
  completed_at: string | null;
  updated_at: string | null;
}

/** What the auto-rerun trigger would do for this plan right now. Reads only. */
export function evaluateQaAutoRerun(planId: string, now = Date.now()): QaAutoRerunDecision {
  const s = getStmts();
  const plan = s.getQaPlan.get(planId);
  if (!plan) return { kind: 'idle', reason: 'plan not found' };
  if (plan.auto_rerun !== 1) return { kind: 'idle', reason: 'auto-rerun is off' };
  if (plan.status !== 'in_progress') return { kind: 'idle', reason: `plan is ${plan.status}` };
  if (!plan.approved_at) return { kind: 'idle', reason: 'plan is not approved' };
  const run = s.getLatestQaRun.get(planId);
  if (!run || run.status !== 'failed') return { kind: 'idle', reason: 'latest run did not fail' };
  if (run.approval_seq !== plan.approval_seq) {
    return { kind: 'idle', reason: 'plan changed since the latest run' };
  }
  if (run.iteration >= plan.max_iterations) return { kind: 'cap_reached', run };

  const findings = getDb()
    .prepare(
      `SELECT res.finding_card_id AS card_id, b.project_id AS board_project_id,
              col.name AS column_name, c.completed_at, c.updated_at
         FROM qa_results res
         LEFT JOIN kanban_cards c ON c.id = res.finding_card_id
         LEFT JOIN kanban_boards b ON b.id = c.board_id
         LEFT JOIN kanban_columns col ON col.id = c.column_id
        WHERE res.run_id = ? AND res.verdict IN ('fail', 'needs_change')`,
    )
    .all(run.id) as FindingCardState[];
  if (findings.length === 0) return { kind: 'idle', reason: 'latest run has no findings to fix' };
  const pending = findings.filter(
    (f) =>
      !f.card_id ||
      f.board_project_id !== plan.project_id ||
      !isColumnDone(f.column_name) ||
      !(f.completed_at ?? f.updated_at),
  );
  if (pending.length > 0) return { kind: 'wait_fixes', run, pending: pending.length };
  const cardIds = [...new Set(findings.map((f) => f.card_id!))];
  const fixesDoneAt = findings
    .map((f) => (f.completed_at ?? f.updated_at)!)
    .reduce((a, b) => (a > b ? a : b));

  if (plan.auto_rerun_trigger === 'merge') {
    const branch = plan.auto_rerun_branch;
    if (!branch) return { kind: 'notify_manual', run, cardIds };
    // The merge carrying the last fix is the latest one inside the grace window
    // that ends when that fix reached Done (`completed_at` has second
    // precision, so the window ends a second later). With none there, the
    // first merge after it carries the fixes.
    const doneMs = timestampMs(fixesDoneAt) + 1000;
    const since = Math.max(timestampMs(run.finished_at), doneMs - 1000 - QA_MERGE_GRACE_MS);
    const mergeQuery = (where: string, order: 'ASC' | 'DESC') =>
      getDb()
        .prepare(
          `SELECT merged_at FROM pull_requests
            WHERE project_id = ? AND base_branch = ? AND merged_at IS NOT NULL AND ${where}
            ORDER BY merged_at ${order} LIMIT 1`,
        )
        .get(plan.project_id, branch, since, doneMs) as { merged_at: number } | undefined;
    const merge =
      mergeQuery('merged_at >= ? AND merged_at < ?', 'DESC') ??
      mergeQuery('merged_at >= MAX(?, ?)', 'ASC');
    if (!merge) return { kind: 'wait_merge', run, branch };
    const dueAt = merge.merged_at + plan.auto_rerun_delay_minutes * 60_000;
    if (now < dueAt) return { kind: 'wait_delay', run, branch, dueAt };
    return { kind: 'rerun', run, target: branch };
  }

  const environment = plan.deploy_environment;
  if (!environment) return { kind: 'notify_manual', run, cardIds };
  const deployment = getDb()
    .prepare(
      `SELECT id FROM deployments
        WHERE project_id = ? AND environment = ? AND status = 'success'
          AND created_at >= ?
        ORDER BY completed_at DESC LIMIT 1`,
    )
    .get(plan.project_id, environment, fixesDoneAt) as { id: string } | undefined;
  if (!deployment) return { kind: 'wait_deploy', run, environment, fixesDoneAt };
  return { kind: 'rerun', run, target: environment };
}

/**
 * One line for the plan detail on where the loop stands, or null when
 * auto-rerun has nothing to say (off, never run, or the latest run passed).
 */
export function describeQaAutoRerun(
  planId: string,
): { kind: string; message: string; dueAt?: string } | null {
  const plan = getStmts().getQaPlan.get(planId);
  if (!plan || plan.auto_rerun !== 1) return null;
  const d = evaluateQaAutoRerun(planId);
  switch (d.kind) {
    case 'idle':
      return null;
    case 'wait_fixes':
      return {
        kind: d.kind,
        message: `Auto-rerun waits for ${d.pending} finding card(s) from run ${d.run.iteration} to reach Done.`,
      };
    case 'cap_reached':
      return {
        kind: d.kind,
        message: `Auto-rerun stopped: the plan reached its limit of ${plan.max_iterations} runs. Rerun by hand.`,
      };
    case 'notify_manual':
      return {
        kind: d.kind,
        message:
          plan.auto_rerun_trigger === 'merge'
            ? 'Every fix is Done, but no branch is chosen, so auto-rerun cannot tell when the fixes reach the target. Rerun by hand once they are deployed.'
            : 'Every fix is Done, but no deploy environment is linked, so auto-rerun cannot tell when the fixes reach the target. Rerun by hand once they are deployed.',
      };
    case 'wait_merge':
      return {
        kind: d.kind,
        message: `Every fix is Done. Auto-rerun waits for a pull request merged into ${d.branch}.`,
      };
    case 'wait_delay':
      return {
        kind: d.kind,
        message: `A merge into ${d.branch} landed. Auto-rerun starts at ${new Date(d.dueAt).toISOString()}.`,
        dueAt: new Date(d.dueAt).toISOString(),
      };
    case 'wait_deploy':
      return {
        kind: d.kind,
        message: `Every fix is Done. Auto-rerun waits for a successful deployment to ${d.environment}.`,
      };
    case 'rerun':
      return d.run.auto_rerun_state === 'rerun_failed'
        ? {
            kind: 'rerun_failed',
            message: `The fixes reached ${d.target}, but the automatic rerun failed to start. Rerun by hand.`,
          }
        : { kind: d.kind, message: `The fixes reached ${d.target}; a rerun is starting.` };
  }
}

/** Claim the run's next auto-rerun state. False when another state already holds it. */
function claimState(runId: string, next: QaAutoRerunState, from: Array<QaAutoRerunState | null>) {
  const allowsNull = from.includes(null);
  const values = from.filter((v): v is QaAutoRerunState => v !== null);
  const clauses = [
    ...(allowsNull ? ['auto_rerun_state IS NULL'] : []),
    ...(values.length ? [`auto_rerun_state IN (${values.map(() => '?').join(', ')})`] : []),
  ];
  return (
    getDb()
      .prepare(`UPDATE qa_runs SET auto_rerun_state = ? WHERE id = ? AND (${clauses.join(' OR ')})`)
      .run(next, runId, ...values).changes === 1
  );
}

function notifyOwner(
  deps: Pick<QaRunLaunchDeps, 'broadcast'>,
  plan: QaPlanRow,
  run: QaRunRow,
  reason: 'cap_reached' | 'manual_rerun_needed' | 'auto_rerun_failed',
  message: string,
): void {
  deps.broadcast({
    type: QA_ATTENTION_EVENT,
    projectId: plan.project_id,
    planId: plan.id,
    planTitle: plan.title,
    runId: run.id,
    iteration: run.iteration,
    reason,
    message,
    notifyUserIds: plan.created_by ? [plan.created_by] : [],
  });
  deps.broadcast({
    type: 'qa_update',
    projectId: plan.project_id,
    planId: plan.id,
    action: 'auto_rerun',
    runId: run.id,
  });
}

export type QaAutoRerunOutcome =
  | 'idle'
  | 'waiting'
  | 'cap_notified'
  | 'manual_notified'
  | 'rerun_started'
  | 'rerun_failed'
  | 'already_handled';

/** Evaluate one plan and act on the decision. Never throws. */
export async function processQaAutoRerun(
  deps: QaRunLaunchDeps,
  planId: string,
): Promise<QaAutoRerunOutcome> {
  try {
    const decision = evaluateQaAutoRerun(planId);
    if (decision.kind === 'idle') return 'idle';
    if (decision.kind === 'wait_delay') {
      scheduleDelayedSweep(deps, planId, decision.dueAt);
      return 'waiting';
    }
    if (
      decision.kind === 'wait_fixes' ||
      decision.kind === 'wait_deploy' ||
      decision.kind === 'wait_merge'
    )
      return 'waiting';
    const plan = getStmts().getQaPlan.get(planId)!;
    const { run } = decision;

    if (decision.kind === 'cap_reached') {
      if (!claimState(run.id, 'cap_notified', [null, 'manual_notified', 'rerun_failed']))
        return 'already_handled';
      notifyOwner(
        deps,
        plan,
        run,
        'cap_reached',
        `Run ${run.iteration} failed and the plan reached its limit of ${plan.max_iterations} runs, so auto-rerun stopped. Start a rerun by hand once the remaining fixes land.`,
      );
      return 'cap_notified';
    }

    if (decision.kind === 'notify_manual') {
      if (!claimState(run.id, 'manual_notified', [null, 'cap_notified'])) return 'already_handled';
      notifyOwner(
        deps,
        plan,
        run,
        'manual_rerun_needed',
        `All ${decision.cardIds.length} fix card(s) from run ${run.iteration} are Done. The plan has no ${plan.auto_rerun_trigger === 'merge' ? 'branch chosen' : 'deploy environment linked'}, so it cannot tell when the fixes reach the target. Rerun it by hand once they are deployed.`,
      );
      return 'manual_notified';
    }

    if (!claimState(run.id, 'rerun_started', [null, 'manual_notified', 'cap_notified']))
      return 'already_handled';
    let error: string;
    try {
      const result = await launchQaRun(deps, plan, {
        scope: 'failed_only',
        startedBy: null,
        ownerUserId: plan.created_by,
      });
      if (result.ok) return 'rerun_started';
      error = result.error;
    } catch (e) {
      // Someone started a run first: the loop moved on without us.
      if (e instanceof QaStatusError && e.code === 'run_active') return 'already_handled';
      error = e instanceof Error ? e.message : String(e);
    }
    claimState(run.id, 'rerun_failed', ['rerun_started']);
    notifyOwner(
      deps,
      plan,
      run,
      'auto_rerun_failed',
      `The fixes from run ${run.iteration} reached ${decision.target}, but the automatic rerun could not start: ${error}`,
    );
    return 'rerun_failed';
  } catch (e) {
    console.error(`[qa] auto-rerun check failed plan=${planId}:`, e);
    return 'idle';
  }
}

const delayTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Re-check a plan when its merge delay ends; no broadcast marks that moment. */
function scheduleDelayedSweep(deps: QaRunLaunchDeps, planId: string, dueAt: number): void {
  const existing = delayTimers.get(planId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(
    () => {
      delayTimers.delete(planId);
      void processQaAutoRerun(deps, planId);
    },
    Math.max(0, dueAt - Date.now()) + 1000,
  );
  timer.unref?.();
  delayTimers.set(planId, timer);
}

/** Plans in the project that auto-rerun could act on. */
function candidatePlanIds(projectId: string): string[] {
  return (
    getDb()
      .prepare(
        `SELECT id FROM qa_plans
          WHERE project_id = ? AND status = 'in_progress' AND auto_rerun = 1
            AND approved_at IS NOT NULL`,
      )
      .all(projectId) as Array<{ id: string }>
  ).map((r) => r.id);
}

export async function sweepProjectQaAutoRerun(
  deps: QaRunLaunchDeps,
  projectId: string,
): Promise<QaAutoRerunOutcome[]> {
  const outcomes: QaAutoRerunOutcome[] = [];
  for (const planId of candidatePlanIds(projectId)) {
    outcomes.push(await processQaAutoRerun(deps, planId));
  }
  return outcomes;
}

let launchDeps: QaRunLaunchDeps | null = null;
const pending = new Map<string, ReturnType<typeof setTimeout>>();
const SWEEP_DEBOUNCE_MS = 2000;

/** Wire the trigger to the server's run-launch deps. */
export function initQaAutoRerun(deps: QaRunLaunchDeps): void {
  launchDeps = deps;
}

/** Broadcasts that can change a trigger condition. */
export function qaAutoRerunProjectFor(data: Record<string, unknown>): string | null {
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!projectId) return null;
  if (data.type === 'kanban_update') return projectId;
  if (data.type === 'deployment_update') {
    const status = (data.deployment as { status?: unknown } | undefined)?.status;
    return status === 'success' ? projectId : null;
  }
  if (data.type === 'qa_update' && data.action === 'plan_updated') return projectId;
  if (data.type === 'native_pr_update' && data.action === 'merged') return projectId;
  return null;
}

/** Schedule a debounced sweep when a broadcast can change a trigger condition. */
export function observeBroadcastForQaAutoRerun(data: Record<string, unknown>): void {
  if (!launchDeps) return;
  const projectId = qaAutoRerunProjectFor(data);
  if (!projectId) return;
  const existing = pending.get(projectId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    pending.delete(projectId);
    if (launchDeps) void sweepProjectQaAutoRerun(launchDeps, projectId);
  }, SWEEP_DEBOUNCE_MS);
  timer.unref?.();
  pending.set(projectId, timer);
}

/** Boot catch-up for every project with an active auto-rerun plan. */
export async function sweepAllQaAutoRerun(deps: QaRunLaunchDeps): Promise<void> {
  const projects = getDb()
    .prepare(
      `SELECT DISTINCT project_id FROM qa_plans WHERE status = 'in_progress' AND auto_rerun = 1`,
    )
    .all() as Array<{ project_id: string }>;
  for (const { project_id } of projects) await sweepProjectQaAutoRerun(deps, project_id);
}
