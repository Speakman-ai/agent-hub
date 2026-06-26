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
import { readFinalizeLoopRound, writeFinalizeRunTerminalTimeline } from './timeline-message.js';
import type { ReviewerVerdict } from './reviewer-dispatch.js';
import { resolveNativePrAuthorUserId } from '../native-pr/author-user.js';
import { postFinalizeApprovalReview } from './post-finalize-approval-review.js';
import {
  hasPushedFinalizeRun,
  lockSessionAfterFinalizePush,
  POST_FINALIZE_PUSH_LOCK_ERROR,
  POST_FINALIZE_PUSH_LOCK_MESSAGE,
} from './post-push-session-lock.js';

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

function finalizePhasePassed(run: FinalizeRunRow | undefined): run is FinalizeRunRow {
  return run?.status === 'ready_to_push' || run?.status === 'pushed';
}

function resolveSessionPushGateSignals(args: {
  stmts: Stmts;
  run: FinalizeRunRow;
  sessionId: string;
  currentHead: string;
}): { baselineSha: string; reviewerVerdict: ReviewerVerdict | null } {
  const { stmts, run, sessionId, currentHead } = args;
  const checksRun = stmts.getLatestChecksRunForSession.get(sessionId) as FinalizeRunRow | undefined;
  const reviewRun = stmts.getLatestReviewRunForSession.get(sessionId) as FinalizeRunRow | undefined;

  if (
    finalizePhasePassed(checksRun) &&
    finalizePhasePassed(reviewRun) &&
    checksRun.validated_head_sha &&
    checksRun.validated_head_sha === reviewRun.validated_head_sha &&
    reviewRun.reviewer_verdict === 'approved'
  ) {
    return { baselineSha: checksRun.validated_head_sha, reviewerVerdict: 'approved' };
  }

  return {
    baselineSha: resolvePushGateBaseline(run, currentHead),
    reviewerVerdict: run.reviewer_verdict ?? 'changes_requested',
  };
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

/**
 * Resolve the worktree's currently checked-out branch name, or `null` when
 * detached / unresolvable.
 *
 * Why this matters: the push gate validates `git rev-parse HEAD` (the
 * checked-out commit), but a session's stored `worktree_branch` can drift
 * if an agent creates and checks out a NEW branch mid-session (the column
 * is not re-synced on checkout). Pushing the stale stored name then targets
 * a branch that does not contain the validated HEAD — `gh pr create` fails
 * with "No commits between …", which the push wrapper mislabels as
 * `github_push_5xx`. Pushing the actually-checked-out branch keeps the push
 * consistent with what the gate validated. Mirrors `auto-git.ts`, which
 * already resolves the current branch the same way.
 */
async function defaultResolveCurrentBranch(worktreePath: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: worktreePath,
      timeout: 30_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    const branch = stdout.trim();
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/**
 * Pick the branch to push: the worktree's checked-out branch when resolvable
 * (it holds the validated HEAD), otherwise the session's stored branch. Logs
 * when the two disagree so the stale-branch condition is visible in the logs.
 */
async function resolvePushBranch(
  worktreePath: string,
  storedBranch: string,
  runOrSessionLabel: string,
  resolveCurrentBranch: (worktreePath: string) => Promise<string | null>,
): Promise<string> {
  const current = await resolveCurrentBranch(worktreePath);
  if (current && current !== storedBranch) {
    console.warn(
      `[finalize-push] checked-out branch '${current}' differs from stored worktree_branch ` +
        `'${storedBranch}' for ${runOrSessionLabel}; pushing the checked-out branch ` +
        `(it holds the validated HEAD)`,
    );
  }
  return current ?? storedBranch;
}

export interface RunFinalizePushArgs {
  deps: RouteDeps;
  project: Project;
  run: FinalizeRunRow;
  card: KanbanCardRow;
  session: SessionRow;
  resolveHeadSha?: (worktreePath: string) => Promise<string>;
  /** Resolve the worktree's checked-out branch (injectable for tests). */
  resolveCurrentBranch?: (worktreePath: string) => Promise<string | null>;
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
  /** Branch to push — the worktree's checked-out branch (holds validated HEAD). */
  pushBranch: string;
  /** True when the push skipped the review + checks gate (force / push anyway). */
  bypassedGates: boolean;
  pushAndCreatePr?: PushAndCreatePrFn;
  lifecycle?: CardLifecycle;
}): Promise<FinalizePushOutcome> {
  const { deps, project, run, card, session, validatedHeadSha, pushBranch, bypassedGates } = args;
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
    session_id: session.id,
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
    // Native-PR author attribution is only required for Agent Hub-hosted PR
    // rows; GitHub PR creation does not need (and does not consume) a Hub
    // author. Resolving it unconditionally would let an auth-enabled but
    // userless/unowned session fail in resolveNativePrAuthorUserId before the
    // GitHub push/PR path even runs. Gate on gitHost so only the native path
    // requires attribution (and keep the triggered-by hint for it).
    const authorUserId =
      project.gitHost === 'agenthub'
        ? resolveNativePrAuthorUserId({
            sessionId: session.id,
            triggeredByUserId: run.triggered_by_user_id,
          })
        : null;
    pushResult = await pushFn({
      runId: run.id,
      worktreePath: session.worktree_path,
      branch: pushBranch,
      baseBranch,
      headSha: validatedHeadSha,
      card,
      project,
      sessionId: session.id,
      authorUserId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[finalize-push] github_push_5xx run=${run.id} branch=${pushBranch} project=${project.id}: ${msg}`,
    );
    try {
      stmts.failFinalizeRun.run('infra_error', 'github_push_5xx', run.id);
    } catch {
      /* best-effort */
    }
    broadcast({
      type: 'finalize_run_phase_changed',
      run_id: run.id,
      session_id: session.id,
      phase: null,
      status: 'infra_error',
      failure_reason: 'github_push_5xx',
    });
    broadcast({
      type: 'finalize_run_completed',
      run_id: run.id,
      session_id: session.id,
      status: 'infra_error',
    });
    return {
      ok: false,
      httpStatus: 502,
      error: 'github_push_5xx',
      message: `Push failed: ${msg}`,
    };
  }

  if (!pushResult.prUrl) {
    console.error(
      `[finalize-push] github_push_5xx run=${run.id} branch=${pushBranch} project=${project.id}: push step returned no PR URL`,
    );
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
    lockSessionAfterFinalizePush(stmts as Stmts, session.id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[finalize-push] persist_failed run=${run.id} branch=${pushBranch} project=${project.id}: ${msg}`,
    );
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
    session_id: session.id,
    phase: 'push',
    status: 'pushed',
  });
  broadcast({
    type: 'finalize_run_completed',
    run_id: run.id,
    session_id: session.id,
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
      bypassedGates,
      prUrl: pushResult.prUrl,
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

  // Mirror a passing Finalize review onto the native PR as an `approved`
  // review so a PR that was sitting at `changes_requested` (e.g. a Resolve PR
  // session) reflects that it passed review. Best-effort, never throws.
  postFinalizeApprovalReview({
    deps,
    project,
    run,
    session,
    prUrl: pushResult.prUrl,
    bypassedGates,
  });

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

  // A cancelled run is never pushable, including via `force` — Stop is
  // authoritative. This is the backstop for the orchestrator's abort
  // checkpoints: even if a push is dispatched against a stale run object, the
  // cancel must win.
  if (run.status === 'cancelled') {
    return {
      ok: false,
      httpStatus: 409,
      error: 'cancelled',
      message: 'This run was cancelled and cannot be pushed.',
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

  if (hasPushedFinalizeRun(deps.stmts as Stmts, session.id)) {
    return {
      ok: false,
      httpStatus: 409,
      error: POST_FINALIZE_PUSH_LOCK_ERROR,
      message: POST_FINALIZE_PUSH_LOCK_MESSAGE,
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
    const { baselineSha, reviewerVerdict } = resolveSessionPushGateSignals({
      stmts: deps.stmts as Stmts,
      run,
      sessionId: session.id,
      currentHead,
    });
    const gate = evaluatePushGate({
      stepStatus: 'success',
      reviewerVerdict,
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

  if (run.status === 'ready_to_push') {
    const claim = deps.stmts.claimFinalizeRunPush.run(run.id, validatedHeadSha);
    if (claim.changes === 0) {
      const fresh = deps.stmts.getFinalizeRun.get(run.id) as FinalizeRunRow | undefined;
      const status = fresh?.status ?? 'unknown';
      const peer = deps.stmts.getFinalizePushPeerForSessionHead.get(
        run.id,
        session.id,
        validatedHeadSha,
      ) as FinalizeRunRow | undefined;
      if (peer?.status === 'pushed' && peer.pr_url) {
        try {
          writeFinalizeRunPrUrl(
            { stmts: deps.stmts as Stmts },
            { runId: run.id, prUrl: peer.pr_url },
          );
          deps.stmts.markFinalizeRunPushed.run(run.id);
          lockSessionAfterFinalizePush(deps.stmts as Stmts, session.id);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            ok: false,
            httpStatus: 500,
            error: 'persist_failed',
            message: msg,
          };
        }
        deps.broadcast({
          type: 'finalize_run_phase_changed',
          run_id: run.id,
          session_id: session.id,
          phase: 'push',
          status: 'pushed',
        });
        deps.broadcast({
          type: 'finalize_run_completed',
          run_id: run.id,
          session_id: session.id,
          status: 'pushed',
          pr_url: peer.pr_url,
        });
        return { ok: true, prUrl: peer.pr_url };
      }
      return {
        ok: false,
        httpStatus: 409,
        error:
          status === 'pushed' || peer?.status === 'pushed' ? 'already_pushed' : 'push_in_flight',
        message:
          status === 'pushed' || peer?.status === 'pushed'
            ? 'This validated head has already been pushed.'
            : `Run is already being pushed (${peer?.status ?? status}).`,
      };
    }
  }

  const pushBranch = await resolvePushBranch(
    session.worktree_path,
    session.worktree_branch,
    `run=${run.id}`,
    args.resolveCurrentBranch ?? defaultResolveCurrentBranch,
  );

  return executePush({
    deps,
    project,
    run,
    card,
    session,
    validatedHeadSha,
    pushBranch,
    // A forced push skips the review + checks gate; a ready_to_push push
    // (force=false) cleared it. This drives the timeline warning.
    bypassedGates: force,
    pushAndCreatePr: args.pushAndCreatePr,
  });
}

export interface RunSessionPushArgs {
  deps: RouteDeps;
  project: Project;
  session: SessionRow;
  card: KanbanCardRow;
  pushAndCreatePr?: PushAndCreatePrFn;
  /** Resolve the worktree HEAD SHA (injectable for tests). */
  resolveHeadSha?: (worktreePath: string) => Promise<string>;
  /** Resolve the worktree's checked-out branch (injectable for tests). */
  resolveCurrentBranch?: (worktreePath: string) => Promise<string | null>;
}

/**
 * Push a session worktree to GitHub without an existing finalize run row.
 * Used when the operator clicks Push before running Finalize.
 */
export async function runSessionPushToGithub(
  args: RunSessionPushArgs,
): Promise<FinalizePushOutcome> {
  const { deps, project, session, card } = args;
  const resolveHead = args.resolveHeadSha ?? defaultResolveHeadSha;
  if (hasPushedFinalizeRun(deps.stmts as Stmts, session.id)) {
    return {
      ok: false,
      httpStatus: 409,
      error: POST_FINALIZE_PUSH_LOCK_ERROR,
      message: POST_FINALIZE_PUSH_LOCK_MESSAGE,
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

  const pushBranch = await resolvePushBranch(
    session.worktree_path,
    session.worktree_branch,
    `session=${session.id}`,
    args.resolveCurrentBranch ?? defaultResolveCurrentBranch,
  );

  const pushFn = args.pushAndCreatePr ?? createPushAndCreatePr({ config: deps.config });
  const runId = `session-push-${uuidv4()}`;
  try {
    const baseBranch = await resolveFinalizeBaseBranchForCard({
      card,
      worktreePath: session.worktree_path,
      getEpic: (epicId) => deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
    });
    // See above: native-PR attribution applies only to Agent Hub-hosted rows;
    // GitHub-backed projects must not fail attribution before their push runs.
    const authorUserId =
      project.gitHost === 'agenthub'
        ? resolveNativePrAuthorUserId({ sessionId: session.id })
        : null;
    const pushResult = await pushFn({
      runId,
      worktreePath: session.worktree_path,
      branch: pushBranch,
      baseBranch,
      headSha: currentHead,
      card,
      project,
      sessionId: session.id,
      authorUserId,
    });
    if (!pushResult.prUrl) {
      console.error(
        `[finalize-push] github_push_5xx session=${session.id} branch=${pushBranch} project=${project.id}: push step returned no PR URL`,
      );
      return {
        ok: false,
        httpStatus: 502,
        error: 'github_push_5xx',
        message: 'Push step returned no PR URL.',
      };
    }
    // No finalize run existed, so review + checks never ran. Record a terminal
    // timeline message marked bypassedGates so the session surfaces an amber
    // "pushed without tests or review" warning instead of silently succeeding.
    writeFinalizeRunTerminalTimeline(
      { stmts: deps.stmts as Stmts, broadcast: deps.broadcast },
      {
        sessionId: session.id,
        runId,
        status: 'pushed',
        bypassedGates: true,
        prUrl: pushResult.prUrl,
      },
    );
    return { ok: true, prUrl: pushResult.prUrl };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[finalize-push] github_push_5xx session=${session.id} branch=${pushBranch} project=${project.id}: ${msg}`,
    );
    return {
      ok: false,
      httpStatus: 502,
      error: 'github_push_5xx',
      message: `Push failed: ${msg}`,
    };
  }
}
