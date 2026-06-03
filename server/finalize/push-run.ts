/**
 * push-run.ts — explicit human-confirmed git push + PR open for Finalize.
 *
 * After rebase, review, and ci.yaml steps pass, the orchestrator parks the
 * run in `ready_to_push`. This module performs phase 8 only when the
 * operator clicks **Push to GitHub**.
 */
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  FinalizeRunRow,
  KanbanCardRow,
  KanbanEpicRow,
  Project,
  RouteDeps,
  SessionRow,
  Stmts,
} from '../types.js';
import { buildOrchestratorDeps } from './orchestrator-deps.js';
import { evaluatePushGate } from './push-gate.js';
import type { PushAndCreatePrFn } from './orchestrator.js';
import { writeFinalizeRunPrUrl } from './provenance.js';
import type { CardLifecycle } from './card-lifecycle.js';
import { NOOP_CARD_LIFECYCLE } from './card-lifecycle.js';
import { createPushAndCreatePr } from './push-and-create-pr.js';
import { getSessionCommittableChanges } from './worktree-changes.js';
import { resolveFinalizeBaseBranchForCard } from './resolve-base-branch.js';
import {
  readFinalizeLoopRound,
  writeFinalizeRunTerminalTimeline,
  type TimelineMessageDeps,
} from './timeline-message.js';

const execFileAsync = promisify(execFile);

export type FinalizePushOutcome =
  | { ok: true; prUrl: string }
  | { ok: false; httpStatus: number; error: string; message: string };

/** Baseline SHA for the §9 push gate at human push time. */
export function resolvePushGateBaseline(run: FinalizeRunRow, currentHead: string): string {
  if (run.validated_head_sha) return run.validated_head_sha;
  // Legacy rows that reached ready_to_push before validated_head_sha was
  // persisted: trust the orchestrator gate and accept current HEAD.
  if (run.status === 'ready_to_push') return currentHead;
  return run.head_sha;
}

async function defaultResolveHeadSha(worktreePath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath,
    timeout: 30_000,
    maxBuffer: 1 * 1024 * 1024,
  });
  const sha = stdout.trim();
  if (!sha) throw new Error('empty rev-parse output');
  return sha;
}

export interface RunFinalizePushArgs {
  deps: RouteDeps;
  project: Project;
  run: FinalizeRunRow;
  card: KanbanCardRow;
  session: SessionRow;
  resolveHeadSha?: (worktreePath: string) => Promise<string>;
  pushAndCreatePr?: PushAndCreatePrFn;
  /** Operator override — skip ready_to_push and push-gate checks. */
  force?: boolean;
}

async function executePush(args: {
  deps: RouteDeps;
  project: Project;
  run: FinalizeRunRow;
  card: KanbanCardRow;
  session: SessionRow;
  validatedHeadSha: string;
  pushAndCreatePr?: PushAndCreatePrFn;
  lifecycle?: CardLifecycle;
}): Promise<FinalizePushOutcome> {
  const { deps, project, run, card, session, validatedHeadSha } = args;
  const { stmts, broadcast } = deps;
  const pushFn =
    args.pushAndCreatePr ?? buildOrchestratorDeps(deps, card, project.id).pushAndCreatePr;
  const lifecycle =
    args.lifecycle ??
    buildOrchestratorDeps(deps, card, project.id).cardLifecycle ??
    NOOP_CARD_LIFECYCLE;

  if (!session.worktree_path || !session.worktree_branch) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }

  try {
    stmts.updateFinalizeRunPhase.run('push', 'pushing', run.id);
  } catch {
    /* best-effort */
  }
  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: run.id,
    phase: 'push',
    status: 'pushing',
  });

  let pushResult: { prUrl: string };
  try {
    const baseBranch = await resolveFinalizeBaseBranchForCard({
      card,
      worktreePath: session.worktree_path,
      getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
    });
    pushResult = await pushFn({
      runId: run.id,
      worktreePath: session.worktree_path,
      branch: session.worktree_branch,
      baseBranch,
      headSha: validatedHeadSha,
      card,
      project,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      stmts.failFinalizeRun.run('infra_error', 'github_push_5xx', run.id);
    } catch {
      /* best-effort */
    }
    broadcast({
      type: 'finalize_run_phase_changed',
      run_id: run.id,
      phase: null,
      status: 'infra_error',
      failure_reason: 'github_push_5xx',
    });
    broadcast({ type: 'finalize_run_completed', run_id: run.id, status: 'infra_error' });
    return {
      ok: false,
      httpStatus: 502,
      error: 'github_push_5xx',
      message: `Push failed: ${msg}`,
    };
  }

  if (!pushResult.prUrl) {
    return {
      ok: false,
      httpStatus: 502,
      error: 'github_push_5xx',
      message: 'Push step returned no PR URL.',
    };
  }

  try {
    writeFinalizeRunPrUrl({ stmts: stmts as Stmts }, { runId: run.id, prUrl: pushResult.prUrl });
    stmts.markFinalizeRunPushed.run(run.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 500,
      error: 'persist_failed',
      message: msg,
    };
  }

  broadcast({
    type: 'finalize_run_phase_changed',
    run_id: run.id,
    phase: 'push',
    status: 'pushed',
  });
  broadcast({
    type: 'finalize_run_completed',
    run_id: run.id,
    status: 'pushed',
    pr_url: pushResult.prUrl,
  });

  writeFinalizeRunTerminalTimeline(
    { stmts: stmts as Stmts, broadcast },
    {
      sessionId: session.id,
      runId: run.id,
      status: 'pushed',
      round: readFinalizeLoopRound(run),
    },
  );

  try {
    lifecycle.onPushed({
      runId: run.id,
      prUrl: pushResult.prUrl,
      triggerSource: run.trigger_source,
    });
  } catch {
    /* cosmetic */
  }

  return { ok: true, prUrl: pushResult.prUrl };
}

/**
 * Push an approved finalize run to GitHub and open the PR.
 */
export async function runFinalizePush(args: RunFinalizePushArgs): Promise<FinalizePushOutcome> {
  const { deps, project, run, card, session, force = false } = args;
  const resolveHead = args.resolveHeadSha ?? defaultResolveHeadSha;

  if (run.status === 'pushed') {
    return {
      ok: false,
      httpStatus: 409,
      error: 'already_pushed',
      message: 'This run has already been pushed.',
    };
  }

  if (!force && run.status !== 'ready_to_push') {
    return {
      ok: false,
      httpStatus: 409,
      error: 'not_ready_to_push',
      message: `Run is ${run.status}; only ready_to_push runs can be pushed.`,
    };
  }
  if (!session.worktree_path || !session.worktree_branch) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }

  const committable = await getSessionCommittableChanges(session.worktree_path);
  if (!committable.ok) {
    return {
      ok: false,
      httpStatus: 400,
      error: committable.error,
      message: committable.message,
    };
  }

  let currentHead: string;
  try {
    currentHead = await resolveHead(session.worktree_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_head_sha',
      message: `Could not resolve HEAD: ${msg}`,
    };
  }

  let validatedHeadSha = currentHead;
  if (!force) {
    const baselineSha = resolvePushGateBaseline(run, currentHead);
    const gate = evaluatePushGate({
      stepStatus: 'success',
      reviewerVerdict: run.reviewer_verdict ?? 'changes_requested',
      headBeforePhases: baselineSha,
      headAtPushGate: currentHead,
    });
    if (gate.kind === 'refuse') {
      return {
        ok: false,
        httpStatus: 409,
        error: gate.refusalCode,
        message:
          gate.refusalCode === 'head_sha_moved'
            ? 'HEAD changed since checks passed. Click Finalize Code Changes again to re-run review and tests.'
            : gate.detail,
      };
    }
    validatedHeadSha = gate.validatedHeadSha;
  }

  return executePush({
    deps,
    project,
    run,
    card,
    session,
    validatedHeadSha,
    pushAndCreatePr: args.pushAndCreatePr,
  });
}

export interface RunSessionPushArgs {
  deps: RouteDeps;
  project: Project;
  session: SessionRow;
  card: KanbanCardRow;
  pushAndCreatePr?: PushAndCreatePrFn;
}

/**
 * Push a session worktree to GitHub without an existing finalize run row.
 * Used when the operator clicks Push before running Finalize.
 */
export async function runSessionPushToGithub(
  args: RunSessionPushArgs,
): Promise<FinalizePushOutcome> {
  const { deps, project, session, card } = args;
  if (!session.worktree_path || !session.worktree_branch) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_worktree',
      message: 'Session has no worktree.',
    };
  }

  const committable = await getSessionCommittableChanges(session.worktree_path);
  if (!committable.ok) {
    return {
      ok: false,
      httpStatus: 400,
      error: committable.error,
      message: committable.message,
    };
  }

  let currentHead: string;
  try {
    currentHead = await defaultResolveHeadSha(session.worktree_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_head_sha',
      message: `Could not resolve HEAD: ${msg}`,
    };
  }

  const pushFn = args.pushAndCreatePr ?? createPushAndCreatePr({ config: deps.config });
  try {
    const baseBranch = await resolveFinalizeBaseBranchForCard({
      card,
      worktreePath: session.worktree_path,
      getEpic: (epicId) => deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
    });
    const pushResult = await pushFn({
      runId: `session-push-${uuidv4()}`,
      worktreePath: session.worktree_path,
      branch: session.worktree_branch,
      baseBranch,
      headSha: currentHead,
      card,
      project,
    });
    if (!pushResult.prUrl) {
      return {
        ok: false,
        httpStatus: 502,
        error: 'github_push_5xx',
        message: 'Push step returned no PR URL.',
      };
    }
    return { ok: true, prUrl: pushResult.prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 502,
      error: 'github_push_5xx',
      message: `Push failed: ${msg}`,
    };
  }
}
