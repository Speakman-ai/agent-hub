/**
 * push-run.ts — explicit human-confirmed git push + PR open for Finalize.
 *
 * After rebase, review, and ci.yaml steps pass, the orchestrator parks the
 * run in `ready_to_push`. This module performs phase 8 only when the
 * operator clicks **Push to GitHub**.
 */
import { v4 as uuidv4 } from 'uuid';
import { execFile } from 'child_process';
import { access } from 'fs/promises';
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
import { sessionWorktreeIoFor } from '../session-worktree-io.js';
import { acquireFinalizeSource } from './session-source.js';
import type { FinalizeSource } from './session-source.js';
import {
  resolveFinalizeBaseBranchForCard,
  resolveFinalizeGateBase,
} from './resolve-base-branch.js';
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
import { stopBackgroundShellsAfterFinalizePush } from './post-push-background-shells.js';
import {
  BASE_BRANCH_MOVED_ERROR,
  BASE_BRANCH_MOVED_MESSAGE,
  inspectBaseDrift,
  type GitRunner,
} from './base-drift.js';
import {
  acquirePushLock,
  PUSH_LOCK_BUSY_ERROR,
  PUSH_LOCK_BUSY_MESSAGE,
  type PushLockStmts,
} from './push-lock.js';

const execFileAsync = promisify(execFile);

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directory holding the commits this run will push.
 *
 * Prefer the staging checkout recorded on the run (env-owned / Firecracker).
 * After a failed auto-push the source reaper may delete that directory while
 * the run row still points at it — rematerialise from the session rather than
 * failing `git rev-parse` with `spawn git ENOENT` (missing cwd).
 */
async function ensurePushSourcePath(args: {
  deps: Pick<RouteDeps, 'stmts'>;
  run: FinalizeRunRow;
  session: SessionRow;
}): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const { deps, run, session } = args;
  const recorded = runSourcePath(run, session);
  if (recorded && (await pathExists(recorded))) {
    return { ok: true, path: recorded };
  }
  if (!session.worktree_path || !session.worktree_branch) {
    return { ok: false, message: 'Session has no worktree.' };
  }
  try {
    const source = await acquireFinalizeSource({
      runId: run.id,
      sessionId: session.id,
      worktreePath: session.worktree_path,
      branch: session.worktree_branch,
    });
    try {
      deps.stmts.updateFinalizeRunWorktreePath.run(source.path, run.id);
    } catch {
      /* best-effort — in-memory path below is enough for this push */
    }
    run.worktree_path = source.path;
    return { ok: true, path: source.path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `Could not restore the finalize source checkout: ${msg}`,
    };
  }
}

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
  if (!run) return false;
  if (run.status === 'ready_to_push' || run.status === 'pushed') return true;
  // Push-step infra failure after gates still carries validated_head_sha.
  return run.status === 'infra_error' && !!run.validated_head_sha;
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

/**
 * The directory holding the commits this run validated.
 *
 * Normally the session's own worktree. When the session runs in its own env
 * the orchestrator materialized a staging checkout and recorded it on the run
 * row — pushing from the session's recorded path would ship the tree the env
 * booted from, which is not what any of the gates looked at.
 */
function runSourcePath(run: FinalizeRunRow, session: SessionRow): string | null {
  return run.worktree_path ?? session.worktree_path ?? null;
}

type SessionMoveCheck =
  | { status: 'shared' }
  | { status: 'ok'; moved: boolean }
  | { status: 'unverified'; reason: string };

/**
 * Did the session commit more work after this run materialized its source?
 *
 * The plain head comparison the push gate makes cannot answer this for a
 * staged run: the staging copy is frozen at the validated commit, so it always
 * matches. Ask the session directly instead, against the head recorded when
 * the copy was taken.
 *
 * Fail closed: an unreadable materialization marker, guest HEAD failure, or
 * thrown source lookup is not proof the session stood still — treating it as
 * "ok to push" can ship a stale staging checkout.
 */
async function sessionMovedSinceMaterialize(
  run: FinalizeRunRow,
  session: SessionRow,
  sourcePath: string,
): Promise<SessionMoveCheck> {
  if (!session.worktree_path || sourcePath === session.worktree_path) {
    return { status: 'shared' };
  }
  try {
    const source = await acquireFinalizeSource({
      runId: run.id,
      sessionId: session.id,
      worktreePath: session.worktree_path,
      branch: session.worktree_branch ?? 'HEAD',
    });
    const materializedFrom = await source.sessionHeadAtMaterialize();
    if (!materializedFrom) {
      return {
        status: 'unverified',
        reason: 'staging checkout has no recorded session HEAD from materialize',
      };
    }
    const io = await sessionWorktreeIoFor(session.id, session.worktree_path);
    const head = await io.git(['rev-parse', 'HEAD']);
    if (head.exitCode !== 0) {
      return {
        status: 'unverified',
        reason:
          `could not read current session HEAD: ` +
          (head.stderr.trim() || head.stdout.trim() || `exit ${head.exitCode}`),
      };
    }
    return { status: 'ok', moved: head.stdout.trim() !== materializedFrom };
  } catch (err) {
    return {
      status: 'unverified',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Move the session's own worktree onto what was just pushed.
 *
 * Only does anything for a staged run: a rebase during Finalize rewrote the
 * commits, and a session left pointing at the pre-rebase history would show
 * its own branch as diverged from the PR that was just opened from it.
 * Best-effort by design — the push already succeeded, so a sync failure is
 * worth a log line and nothing more.
 */
async function syncSessionAfterPush(
  run: FinalizeRunRow,
  session: SessionRow,
  branch: string,
): Promise<void> {
  if (!run.worktree_path || run.worktree_path === session.worktree_path) return;
  if (!session.worktree_path) return;
  try {
    const source = await acquireFinalizeSource({
      runId: run.id,
      sessionId: session.id,
      worktreePath: session.worktree_path,
      branch,
    });
    const result = await source.syncBack(branch);
    if (!result.synced) {
      console.warn(
        `[finalize-push] session=${session.id} still points at its pre-push commits: ${result.reason}`,
      );
    }
  } catch (err) {
    console.warn(
      `[finalize-push] could not move session=${session.id} onto ${branch}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
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
  /** Test seam: production builds the lifecycle from route deps. */
  cardLifecycle?: CardLifecycle;
  /** Operator override — skip ready_to_push and push-gate checks. */
  force?: boolean;
  /** Test seam: git runner for the base-drift check. */
  inspectBaseDriftGit?: GitRunner;
  /**
   * Landing-lock overrides. The automation path passes the wait/poll knobs
   * it wants; tests inject a clock and sleep.
   */
  pushLock?: {
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    waitMs?: number;
    staleMs?: number;
    pollMs?: number;
  };
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
  /**
   * True when the base moved onto ground this branch touches and the push
   * went ahead anyway (forced pushes only). Surfaced in the timeline so the
   * stale base is visible after the fact.
   */
  baseDrifted?: boolean;
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

  const sourcePath = runSourcePath(run, session);
  if (!sourcePath || !session.worktree_branch) {
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
      worktreePath: sourcePath,
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
      worktreePath: sourcePath,
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

  // The session is now locked in ask mode and will never ship again — its
  // background shells go with it. Awaited so the "pushed" broadcast below
  // cannot beat a still-armed shell into dispatching a wake turn.
  //
  // Guarded even though the callee documents itself as non-throwing: past this
  // line the push is persisted and the PR is open on GitHub, so *nothing*
  // cosmetic may turn it into a reported failure. This is the layer that makes
  // that true independently of the callee's contract holding.
  await stopBackgroundShellsAfterFinalizePush(deps, session.id).catch((err: unknown) => {
    console.warn(
      `[finalize-push] background-shell teardown threw run=${run.id} session=${session.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

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
      baseDrifted: args.baseDrifted ?? false,
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

  await syncSessionAfterPush(run, session, pushBranch);

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

  // Allow a retry after the push step itself failed (auto-push / lease /
  // remote blip). Gates already passed — `validated_head_sha` is the proof —
  // so requiring a full Finalize re-run would only re-burn CI for a ship
  // that already cleared review + checks.
  const pushRetryable =
    run.status === 'infra_error' && run.phase === 'push' && !!run.validated_head_sha;
  if (!force && run.status !== 'ready_to_push' && !pushRetryable) {
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

  const gateBase = resolveFinalizeGateBase({
    card,
    worktreePath: session.worktree_path,
    getEpic: (epicId) => deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
  });
  // `requirePushableHead`: this is the ship gate, so it must judge HEAD, not the
  // working tree. A session that staged its work without committing has a dirty
  // worktree and an empty HEAD; without this the dirty-worktree shortcut passes
  // the gate and pushes a branch identical to base (zero-diff PR, then a
  // zero-diff merge under auto-merge automation).
  const committable = await getSessionCommittableChanges(
    await sessionWorktreeIoFor(session.id, session.worktree_path),
    { base: gateBase, requirePushableHead: true },
  );
  if (!committable.ok) {
    return {
      ok: false,
      httpStatus: 400,
      error: committable.error,
      message: committable.message,
    };
  }

  const ensured = await ensurePushSourcePath({ deps, run, session });
  if (!ensured.ok) {
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_worktree',
      message: ensured.message,
    };
  }
  const sourcePath = ensured.path;

  let currentHead: string;
  try {
    currentHead = await resolveHead(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_head_sha',
      message: `Could not resolve HEAD: ${msg}`,
    };
  }

  if (!force) {
    const moveCheck = await sessionMovedSinceMaterialize(run, session, sourcePath);
    switch (moveCheck.status) {
      case 'shared':
        break;
      case 'ok':
        if (moveCheck.moved) {
          return {
            ok: false,
            httpStatus: 409,
            error: 'head_sha_moved',
            message:
              'HEAD changed since checks passed. Click Finalize Code Changes again to re-run review and tests.',
          };
        }
        break;
      case 'unverified':
        return {
          ok: false,
          httpStatus: 409,
          error: 'session_head_unverified',
          message:
            `Could not verify the session still matches the materialized checkout ` +
            `(${moveCheck.reason}). Click Finalize Code Changes again.`,
        };
      default: {
        const _exhaustive: never = moveCheck;
        return _exhaustive;
      }
    }
  }

  // Serialize the whole check-through-landing sequence on (project, base).
  // The drift check alone is check-then-act: two runs can both read the same
  // base as clean and both land on it. Holding this lock means the second run
  // only evaluates drift once the first has finished landing, so it sees the
  // base the first one produced. Re-entrant by run id — the automation path
  // takes the same lock around push + auto-merge before calling in here.
  const lockBaseBranch = await resolveFinalizeBaseBranchForCard({
    card,
    worktreePath: sourcePath,
    getEpic: (epicId) => deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
  });
  const lock = await acquirePushLock({
    stmts: deps.stmts as PushLockStmts,
    projectId: project.id,
    baseBranch: lockBaseBranch,
    holderRunId: run.id,
    ...(args.pushLock ?? {}),
  });
  if (!lock.ok) {
    console.warn(
      `[finalize-push] refused push run=${run.id}: landing lock for ${project.id}/${lockBaseBranch} ` +
        `held by run=${lock.heldBy ?? 'unknown'}`,
    );
    return {
      ok: false,
      httpStatus: 409,
      error: PUSH_LOCK_BUSY_ERROR,
      message: PUSH_LOCK_BUSY_MESSAGE,
    };
  }
  try {
    let validatedHeadSha = currentHead;
    let baseDrifted = false;
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

    // The base can move between parking at ready_to_push and this push — that
    // window is minutes to hours, and two sessions landing in it is exactly
    // how a project ends up with two branches that were each green alone and
    // broken together. Unrelated base movement passes; only movement onto
    // ground this branch also changes is stale.
    //
    // Evaluated on the forced path too. `force` means "I accept shipping
    // without review and checks", which is a statement about THIS branch;
    // whether the base moved underneath is a fact about the repository that
    // the operator still deserves to see. A forced push is not blocked by it
    // (the overlap test is a directory-level heuristic, and Push Anyway has
    // to remain an escape hatch), but it is logged and carried into the
    // timeline entry so the push is never silently stale.
    const drift = await inspectBaseDrift({
      worktreePath: sourcePath,
      baseBranch: lockBaseBranch,
      validatedBaseSha: run.validated_base_sha ?? null,
      headSha: validatedHeadSha,
      git: args.inspectBaseDriftGit,
      onWarn: (message) =>
        console.warn(`[finalize-push] base drift check degraded run=${run.id}: ${message}`),
    });
    if (drift.kind === 'stale') {
      if (!force) {
        console.warn(`[finalize-push] refused push run=${run.id}: ${drift.detail}`);
        return {
          ok: false,
          httpStatus: 409,
          error: BASE_BRANCH_MOVED_ERROR,
          message: BASE_BRANCH_MOVED_MESSAGE,
        };
      }
      baseDrifted = true;
      console.warn(
        `[finalize-push] forced push run=${run.id} proceeding over base drift: ${drift.detail}`,
      );
    }

    if (run.status === 'ready_to_push' || pushRetryable) {
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
          // Adopting a peer's push locks this session too, so its shells are
          // just as dead as the pushing run's. Guarded for the same reason as the
          // primary push path: the peer's PR already exists.
          await stopBackgroundShellsAfterFinalizePush(deps, session.id).catch((err: unknown) => {
            console.warn(
              `[finalize-push] background-shell teardown threw run=${run.id} session=${session.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
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
          try {
            const lifecycle =
              args.cardLifecycle ??
              buildOrchestratorDeps(deps, card, project.id).cardLifecycle ??
              NOOP_CARD_LIFECYCLE;
            lifecycle.onPushed({
              runId: run.id,
              prUrl: peer.pr_url,
              triggerSource: run.trigger_source,
            });
          } catch {
            /* cosmetic */
          }
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
      sourcePath,
      session.worktree_branch,
      `run=${run.id}`,
      args.resolveCurrentBranch ?? defaultResolveCurrentBranch,
    );

    return await executePush({
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
      baseDrifted,
      pushAndCreatePr: args.pushAndCreatePr,
      lifecycle: args.cardLifecycle,
    });
  } finally {
    lock.handle.release();
  }
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

  const gateBase = resolveFinalizeGateBase({
    card,
    worktreePath: session.worktree_path,
    getEpic: (epicId) => deps.stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
  });
  // `requirePushableHead`: this is the ship gate, so it must judge HEAD, not the
  // working tree. A session that staged its work without committing has a dirty
  // worktree and an empty HEAD; without this the dirty-worktree shortcut passes
  // the gate and pushes a branch identical to base (zero-diff PR, then a
  // zero-diff merge under auto-merge automation).
  const committable = await getSessionCommittableChanges(
    await sessionWorktreeIoFor(session.id, session.worktree_path),
    { base: gateBase, requirePushableHead: true },
  );
  if (!committable.ok) {
    return {
      ok: false,
      httpStatus: 400,
      error: committable.error,
      message: committable.message,
    };
  }

  const runId = `session-push-${uuidv4()}`;
  // This path pushes the session's own commits with no rebase, so the staging
  // copy (when there is one) is a read-only hand-off to git and is dropped
  // again below — nothing to carry back into the session afterwards.
  let source: FinalizeSource;
  try {
    source = await acquireFinalizeSource({
      runId,
      sessionId: session.id,
      worktreePath: session.worktree_path,
      branch: session.worktree_branch,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      httpStatus: 500,
      error: 'no_worktree',
      message: `Could not read the session's code to push: ${msg}`,
    };
  }
  const sourcePath = source.path;

  let currentHead: string;
  try {
    currentHead = await resolveHead(sourcePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await source.release();
    return {
      ok: false,
      httpStatus: 400,
      error: 'no_head_sha',
      message: `Could not resolve HEAD: ${msg}`,
    };
  }

  const pushBranch = await resolvePushBranch(
    sourcePath,
    session.worktree_branch,
    `session=${session.id}`,
    args.resolveCurrentBranch ?? defaultResolveCurrentBranch,
  );

  const pushFn = args.pushAndCreatePr ?? createPushAndCreatePr({ config: deps.config });
  try {
    const baseBranch = await resolveFinalizeBaseBranchForCard({
      card,
      worktreePath: sourcePath,
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
      worktreePath: sourcePath,
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
  } finally {
    await source.release();
  }
}
