/**
 * trigger-run.ts — shared Finalize run kickoff for card and session routes.
 */
import { createHash } from 'crypto';
import type { AuthenticatedRequest } from '../auth.js';
import type {
  FinalizeRunMode,
  FinalizeRunRow,
  FinalizeRunStatus,
  KanbanCardRow,
  KanbanEpicRow,
  Project,
  RouteDeps,
  SessionRow,
} from '../types.js';
import { computeIdempotencyKey, runFinalize } from './orchestrator.js';
import { buildOrchestratorDeps } from './orchestrator-deps.js';
import { getSessionCommittableChanges } from './worktree-changes.js';
import { sessionWorktreeIoFor } from '../session-worktree-io.js';
import {
  resolveFinalizeBaseBranchForCard,
  resolveFinalizeGateBase,
} from './resolve-base-branch.js';
import {
  createFinalizeRunSignal,
  registerFinalizeRunAbort,
  unregisterFinalizeRunAbort,
} from './run-abort-registry.js';
import {
  getSessionWorktreeLockOwner,
  releaseSessionWorktreeLock,
  tryAcquireSessionWorktreeLock,
  waitForSessionWorktreeLockRelease,
} from '../session-worktree-lock.js';
import {
  hasPushedFinalizeRun,
  POST_FINALIZE_PUSH_LOCK_ERROR,
  POST_FINALIZE_PUSH_LOCK_MESSAGE,
} from './post-push-session-lock.js';
import { suppressBackgroundShellWakesForFinalize } from './pre-finalize-background-shells.js';

const TERMINAL_STATUSES: ReadonlySet<FinalizeRunStatus> = new Set<FinalizeRunStatus>([
  'pushed',
  'failed',
  'timed_out',
  'infra_error',
  'cancelled',
  'stalled_no_response',
]);

const ROW_VISIBILITY_POLL_INTERVAL_MS = 20;
const ROW_VISIBILITY_POLL_MAX_ATTEMPTS = 15;
const KICKOFF_CLAIM_TTL_MS = 5 * 60 * 1000;

// Baseline run identity captured by the process that owns each Finalize
// worktree lock. A contending request cannot take this snapshot itself: by the
// time it observes the lock, a fast owner may already have inserted and
// terminalized its row. Binding the baseline to lock acquisition lets the
// contender prove whether a later row was created by that owner.
const finalizeLockBaselineRunIds = new Map<string, string | null>();

/**
 * Defensive ceiling on manual re-run attempts probed for a single head SHA.
 * Each `attempt` produces a distinct idempotency key, so in practice the walk
 * stops at the first unused slot; the cap only guards against a pathological
 * lookup that never frees one. Far above any real usage — nobody re-runs one
 * commit 200 times.
 */
const MAX_FINALIZE_ATTEMPTS = 200;

export type ResolveFinalizeAttemptResult =
  | { kind: 'start'; attempt: number; idempotencyKey: string }
  | { kind: 'reused'; run: FinalizeRunRow }
  | { kind: 'in_flight'; run: FinalizeRunRow }
  | { kind: 'ready_to_push'; run: FinalizeRunRow };

/**
 * Decide which Finalize attempt a kickoff should open for a head SHA.
 *
 * The Finalize strip is an append-only timeline. Walking `attempt` from 1,
 * we probe each attempt's idempotency key:
 *
 *   - no row at this attempt  → `start` here (a fresh run + bubble);
 *   - row is `ready_to_push`  → short-circuit, tell the caller to push;
 *   - row is non-terminal     → `in_flight`, never start a duplicate;
 *   - row is terminal (done)  → an explicit user trigger (`ui_button`)
 *     advances to the NEXT attempt so the re-run gets its own row/bubble;
 *     an automated trigger (`agent_block`) dedups onto the finished run.
 *
 * Pure over the injected `lookup` so it can be unit-tested without the DB.
 */
export function resolveFinalizeAttempt(args: {
  projectId: string;
  branch: string;
  headSha: string;
  mode: FinalizeRunMode;
  triggerSource: 'ui_button' | 'agent_block';
  lookup: (idempotencyKey: string) => FinalizeRunRow | undefined;
}): ResolveFinalizeAttemptResult {
  let lastTerminal: FinalizeRunRow | undefined;
  for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt++) {
    const idempotencyKey = computeIdempotencyKey({
      projectId: args.projectId,
      branch: args.branch,
      headSha: args.headSha,
      mode: args.mode,
      attempt,
    });
    const existing = args.lookup(idempotencyKey);
    if (!existing) {
      return { kind: 'start', attempt, idempotencyKey };
    }
    if (existing.status === 'ready_to_push') {
      return { kind: 'ready_to_push', run: existing };
    }
    if (!TERMINAL_STATUSES.has(existing.status)) {
      return { kind: 'in_flight', run: existing };
    }
    // Terminal (finished) run on this attempt. Automated triggers reuse it;
    // an explicit user click advances to a fresh attempt for a new bubble.
    if (args.triggerSource !== 'ui_button') {
      return { kind: 'reused', run: existing };
    }
    lastTerminal = existing;
  }
  // Cap exhausted (pathological). Reuse the most recent terminal row rather
  // than spinning forever — the caller surfaces it as a no-op reuse.
  return { kind: 'reused', run: lastTerminal as FinalizeRunRow };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kickoffClaimKey(args: { sessionId: string; branch: string }): string {
  return createHash('sha256').update(args.sessionId).update('\0').update(args.branch).digest('hex');
}

export type TriggerFinalizeRunResult =
  | { httpStatus: 200; body: { run_id: string; status: string; reused: boolean; card_id: string } }
  | {
      httpStatus: 202;
      body: { ok: true; run_id: null; status: string; message: string; card_id: string };
    }
  | { httpStatus: 409; body: { error: string; run_id: string; status: string; message: string } }
  | { httpStatus: 409; body: { error: string; message: string } }
  | {
      httpStatus: 400;
      body: { error: string; message: string };
    };

export type StartFinalizeRunBackgroundResult =
  | { ok: true; runId: string; status: string }
  | { ok: false; error: string; runId?: string; message?: string };

type KickoffFinalizeRunArgs = {
  project: Project;
  card: KanbanCardRow;
  session: SessionRow;
  triggerSource: 'ui_button' | 'agent_block';
  triggeredByUserId: string;
  mode?: FinalizeRunMode;
  onFinalizeStarted?: () => void;
  onFinalizeSettled?: () => void;
};

async function kickoffFinalizeRunBody(
  deps: RouteDeps,
  args: KickoffFinalizeRunArgs,
): Promise<
  | { kind: 'started'; runId: string; status: string }
  | { kind: 'reused'; runId: string; status: string }
  | { kind: 'ready_to_push'; runId: string }
  | { kind: 'in_flight'; runId: string; status: string }
  | { kind: 'error'; error: string; message: string }
> {
  const { project, card, session } = args;
  const { stmts } = deps;
  const mode: FinalizeRunMode = args.mode ?? 'full';

  if (!session.worktree_path) {
    return { kind: 'error', error: 'no_worktree', message: 'Session has no worktree_path.' };
  }
  if (!session.worktree_branch) {
    return { kind: 'error', error: 'no_branch', message: 'Session has no worktree_branch.' };
  }

  // Defense in depth for the post-push lock. HTTP kickoff already checks this
  // before calling in; automation can still race past its entry gate while a
  // sibling push marks the session pushed — refuse any kickoff once a pushed
  // finalize_runs row exists for the session. Re-check after every await below
  // (and again after the kickoff claim): push does not share this function's
  // early return, so a TOCTOU across worktree I/O would otherwise start a new
  // agent_block run on an already-shipped session.
  const refuseIfPushed = (): { kind: 'error'; error: string; message: string } | null => {
    if (!hasPushedFinalizeRun(stmts, session.id)) return null;
    return {
      kind: 'error',
      error: POST_FINALIZE_PUSH_LOCK_ERROR,
      message: POST_FINALIZE_PUSH_LOCK_MESSAGE,
    };
  };
  {
    const blocked = refuseIfPushed();
    if (blocked) return blocked;
  }

  const gateBase = resolveFinalizeGateBase({
    card,
    worktreePath: session.worktree_path,
    getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
  });
  const io = await sessionWorktreeIoFor(session.id, session.worktree_path);
  {
    const blocked = refuseIfPushed();
    if (blocked) return blocked;
  }
  const committable = await getSessionCommittableChanges(io, { base: gateBase });
  if (!committable.ok) {
    return { kind: 'error', error: committable.error, message: committable.message };
  }
  {
    const blocked = refuseIfPushed();
    if (blocked) return blocked;
  }

  // Read from the session, not its recorded path: the head this resolves
  // becomes the run's idempotency key and the sha the gates are judged
  // against, so a stale read here mislabels the entire run.
  let headSha: string;
  try {
    const head = await io.git(['rev-parse', 'HEAD'], { timeoutMs: 30_000 });
    if (head.exitCode !== 0) throw new Error(head.stderr.trim() || 'git rev-parse HEAD failed');
    headSha = head.stdout.trim();
    if (!headSha) throw new Error('empty rev-parse output');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: 'no_head_sha', message: `Could not resolve HEAD: ${msg}` };
  }
  {
    const blocked = refuseIfPushed();
    if (blocked) return blocked;
  }

  // Resolve which attempt this kickoff opens. Each explicit user click of
  // "Finalize" against a head whose previous run finished gets its own
  // attempt number — and thus its own idempotency key, finalize_runs row,
  // and timeline bubble. We never reuse a finished run for an explicit user
  // trigger (the "Reused" complaint). In-flight runs still dedup, and
  // automated triggers keep reusing a finished run.
  const decision = resolveFinalizeAttempt({
    projectId: project.id,
    branch: session.worktree_branch,
    headSha,
    mode,
    triggerSource: args.triggerSource,
    lookup: (key) => stmts.getFinalizeRunByIdempotencyKey.get(key) as FinalizeRunRow | undefined,
  });
  if (decision.kind === 'ready_to_push') {
    return { kind: 'ready_to_push', runId: decision.run.id };
  }
  if (decision.kind === 'in_flight') {
    return { kind: 'in_flight', runId: decision.run.id, status: decision.run.status };
  }
  if (decision.kind === 'reused') {
    return { kind: 'reused', runId: decision.run.id, status: decision.run.status };
  }
  const { attempt, idempotencyKey } = decision;

  const activeForBranch = stmts.getActiveFinalizeRunForSessionBranch.get(
    session.id,
    session.worktree_branch,
  ) as FinalizeRunRow | undefined;
  if (activeForBranch) {
    return { kind: 'in_flight', runId: activeForBranch.id, status: activeForBranch.status };
  }

  const claimKey = kickoffClaimKey({
    sessionId: session.id,
    branch: session.worktree_branch,
  });
  stmts.pruneStaleFinalizeKickoffClaims.run(Date.now() - KICKOFF_CLAIM_TTL_MS);
  const claimResult = stmts.insertFinalizeKickoffClaim.run(
    claimKey,
    session.id,
    session.worktree_branch,
    mode,
    Date.now(),
  ) as { changes?: number };
  if ((claimResult.changes ?? 0) === 0) {
    for (let i = 0; i < ROW_VISIBILITY_POLL_MAX_ATTEMPTS; i++) {
      const active = stmts.getActiveFinalizeRunForSessionBranch.get(
        session.id,
        session.worktree_branch,
      ) as FinalizeRunRow | undefined;
      if (active) {
        return { kind: 'in_flight', runId: active.id, status: active.status };
      }
      await sleep(ROW_VISIBILITY_POLL_INTERVAL_MS);
    }
    return { kind: 'in_flight', runId: '', status: 'queued' };
  }

  // Claim held: combine with the pushed predicate before launching. A sibling
  // push can land between the last refuseIfPushed and claim insert; without
  // this check we would still start a fresh run.
  {
    const blocked = refuseIfPushed();
    if (blocked) {
      stmts.deleteFinalizeKickoffClaim.run(claimKey);
      return blocked;
    }
  }

  let shouldReleaseClaim = true;
  let runFinalizeStarted = false;
  try {
    const orchestratorDeps = buildOrchestratorDeps(deps, card, project.id);
    const ownerId = args.triggeredByUserId;
    const baseBranch = await resolveFinalizeBaseBranchForCard({
      card,
      worktreePath: session.worktree_path,
      getEpic: (epicId) => stmts.getKanbanEpic.get(epicId) as KanbanEpicRow | undefined,
    });
    {
      const blocked = refuseIfPushed();
      if (blocked) return blocked;
    }
    // Cancellation handle: the orchestrator honors this signal at every
    // awaitable boundary. We register it under the run's id (once visible)
    // so the HTTP cancel route can trip it across call stacks, halting the
    // fix-dispatch loop and any in-flight reviewer turn.
    const { signal, abort } = createFinalizeRunSignal();
    let registeredRunId: string | null = null;
    let settled = false;
    const orchestratorPromise = runFinalize(orchestratorDeps, {
      card,
      project,
      branch: session.worktree_branch,
      headSha,
      baseBranch,
      worktreePath: session.worktree_path,
      sessionId: session.id,
      triggerSource: args.triggerSource,
      triggeredByUserId: ownerId,
      authorName: ownerId,
      authorEmail: `${ownerId}@local`,
      mode,
      attempt,
      signal,
    });
    runFinalizeStarted = true;
    orchestratorPromise
      .catch((err: unknown) => {
        console.warn(
          `[finalize] background runFinalize threw for card=${card.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      })
      .finally(() => {
        settled = true;
        if (registeredRunId) unregisterFinalizeRunAbort(registeredRunId);
        // A rejection before runFinalize inserts its row leaves no durable run
        // for the claim to protect. The HTTP visibility poll may still be in
        // progress (or may already have returned 202), so release the claim
        // here as well; a duplicate that observed our worktree lock can then
        // retry instead of waiting for the stale-claim TTL.
        if (!registeredRunId) stmts.deleteFinalizeKickoffClaim.run(claimKey);
        args.onFinalizeSettled?.();
      });
    args.onFinalizeStarted?.();

    for (let i = 0; i < ROW_VISIBILITY_POLL_MAX_ATTEMPTS; i++) {
      const created = stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
        | FinalizeRunRow
        | undefined;
      if (created) {
        registeredRunId = created.id;
        shouldReleaseClaim = true;
        // The run may have already settled within this poll window — register
        // then immediately reconcile so we never leak a dead entry.
        registerFinalizeRunAbort(created.id, abort);
        if (settled) unregisterFinalizeRunAbort(created.id);
        return { kind: 'started', runId: created.id, status: created.status };
      }
      await sleep(ROW_VISIBILITY_POLL_INTERVAL_MS);
    }

    shouldReleaseClaim = false;
    return { kind: 'started', runId: '', status: 'queued' };
  } finally {
    if (shouldReleaseClaim || !runFinalizeStarted) {
      stmts.deleteFinalizeKickoffClaim.run(claimKey);
    }
  }
}

/**
 * Start Finalize while reserving the session worktree for the entire
 * orchestrator lifetime. The reservation is transferred to the background
 * promise after kickoff, then released when that promise settles.
 */
async function kickoffFinalizeRun(
  deps: RouteDeps,
  args: Omit<KickoffFinalizeRunArgs, 'onFinalizeStarted' | 'onFinalizeSettled'>,
): ReturnType<typeof kickoffFinalizeRunBody> {
  const { stmts } = deps;
  const current = stmts.getSession.get(args.session.id) as SessionRow | undefined;
  if (!current) {
    return { kind: 'error', error: 'session_not_found', message: 'Session not found.' };
  }

  // Disarm watches before the git/claim work. A background pytest that
  // finishes during kickoff used to wake a new agent process into the
  // in-flight Finalize run ("you are now in a new process").
  suppressBackgroundShellWakesForFinalize(deps, current.id);

  let lockHeld = false;
  let lockTransferred = false;
  let session: SessionRow = current;

  if (current.worktree_path && current.worktree_branch) {
    while (!tryAcquireSessionWorktreeLock(current.id, 'finalize')) {
      // Do not queue one Finalize kickoff behind another. Once the first run
      // settles, an explicit UI trigger would see its terminal row and advance
      // to a fresh attempt, turning a duplicate request into an unintended
      // second run. The lock is acquired before the run row is inserted, so
      // wait for that row (or for the owner to settle) rather than returning a
      // malformed in-flight response with an empty run id. Other lock owners
      // (a turn start, branch switch, or multi-agent round) still need the
      // original wait-and-retry behavior.
      if (getSessionWorktreeLockOwner(current.id) === 'finalize') {
        const ownerBaselineRunId = finalizeLockBaselineRunIds.get(current.id);
        while (getSessionWorktreeLockOwner(current.id) === 'finalize') {
          const active = stmts.getActiveFinalizeRunForSessionBranch.get(
            current.id,
            current.worktree_branch,
          ) as FinalizeRunRow | undefined;
          if (active?.id) {
            return { kind: 'in_flight', runId: active.id, status: active.status };
          }
          await sleep(ROW_VISIBILITY_POLL_INTERVAL_MS);
        }

        // A very short run can become ready/terminal between polls and release
        // the lock before the active-only query sees it. Reuse that completed
        // overlapping run instead of advancing this duplicate UI request to a
        // new attempt. If no row was ever created, retry lock acquisition so a
        // failed pre-row kickoff does not wedge the session.
        const latest = stmts.getLatestFinalizeRunForSession.get(current.id) as
          | FinalizeRunRow
          | undefined;
        if (
          ownerBaselineRunId !== undefined &&
          latest?.id &&
          latest.id !== ownerBaselineRunId &&
          latest.branch === current.worktree_branch
        ) {
          if (latest.status === 'ready_to_push') {
            return { kind: 'ready_to_push', runId: latest.id };
          }
          if (TERMINAL_STATUSES.has(latest.status)) {
            return { kind: 'reused', runId: latest.id, status: latest.status };
          }
          return { kind: 'in_flight', runId: latest.id, status: latest.status };
        }
        continue;
      }
      await waitForSessionWorktreeLockRelease(current.id);
    }
    lockHeld = true;
    const baseline = stmts.getLatestFinalizeRunForSession.get(current.id) as
      | FinalizeRunRow
      | undefined;
    finalizeLockBaselineRunIds.set(current.id, baseline?.id ?? null);
    const refreshed = stmts.getSession.get(current.id) as SessionRow | undefined;
    if (!refreshed) {
      releaseSessionWorktreeLock(current.id, 'finalize');
      finalizeLockBaselineRunIds.delete(current.id);
      return { kind: 'error', error: 'session_not_found', message: 'Session not found.' };
    }
    session = refreshed;
  }

  try {
    return await kickoffFinalizeRunBody(deps, {
      ...args,
      session,
      onFinalizeStarted: () => {
        lockTransferred = lockHeld;
        lockHeld = false;
      },
      onFinalizeSettled: () => {
        if (lockTransferred) {
          lockTransferred = false;
          releaseSessionWorktreeLock(session.id, 'finalize');
          finalizeLockBaselineRunIds.delete(session.id);
          setImmediate(() => deps.drainSessionQueue?.(session.id));
        }
      },
    });
  } finally {
    if (lockHeld) {
      releaseSessionWorktreeLock(session.id, 'finalize');
      finalizeLockBaselineRunIds.delete(session.id);
    }
  }
}

/** Background Finalize kickoff for automation (no HTTP req). */
export async function startFinalizeRunBackground(
  deps: RouteDeps,
  args: {
    project: Project;
    card: KanbanCardRow;
    session: SessionRow;
    triggerSource?: 'ui_button' | 'agent_block';
    triggeredByUserId?: string;
  },
): Promise<StartFinalizeRunBackgroundResult> {
  const outcome = await kickoffFinalizeRun(deps, {
    project: args.project,
    card: args.card,
    session: args.session,
    triggerSource: args.triggerSource ?? 'agent_block',
    triggeredByUserId: args.triggeredByUserId ?? 'automation',
  });
  switch (outcome.kind) {
    case 'started':
      return { ok: true, runId: outcome.runId, status: outcome.status };
    case 'reused':
      return { ok: true, runId: outcome.runId, status: outcome.status };
    case 'ready_to_push':
      return { ok: false, error: 'ready_to_push', runId: outcome.runId };
    case 'in_flight':
      return { ok: true, runId: outcome.runId, status: outcome.status };
    case 'error':
      return { ok: false, error: outcome.error, message: outcome.message };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

export async function triggerFinalizeRun(
  deps: RouteDeps,
  args: {
    req: AuthenticatedRequest;
    project: Project;
    card: KanbanCardRow;
    session: SessionRow;
    mode?: FinalizeRunMode;
  },
): Promise<TriggerFinalizeRunResult> {
  const { req, project, card, session } = args;
  const ownerId = req.authUserId ?? card.created_by ?? 'unknown';
  const outcome = await kickoffFinalizeRun(deps, {
    project,
    card,
    session,
    triggerSource: 'ui_button',
    triggeredByUserId: ownerId,
    mode: args.mode,
  });

  switch (outcome.kind) {
    case 'error':
      // Match the HTTP pre-check for the post-push lock so a TOCTOU refuse
      // inside kickoff surfaces the same 409 clients already handle.
      if (outcome.error === POST_FINALIZE_PUSH_LOCK_ERROR) {
        return {
          httpStatus: 409,
          body: { error: outcome.error, message: outcome.message },
        };
      }
      return {
        httpStatus: 400,
        body: { error: outcome.error, message: outcome.message },
      };
    case 'ready_to_push':
      return {
        httpStatus: 409,
        body: {
          error: 'ready_to_push',
          run_id: outcome.runId,
          status: 'ready_to_push',
          message:
            'Checks already passed for this commit. Click **Push** on the session, or cancel and re-run Finalize after new changes.',
        },
      };
    case 'in_flight':
      return {
        httpStatus: 409,
        body: {
          error: 'in_flight',
          run_id: outcome.runId,
          status: outcome.status,
          message: 'A Finalize run is already in flight for this branch + head SHA.',
        },
      };
    case 'reused':
      return {
        httpStatus: 200,
        body: {
          run_id: outcome.runId,
          status: outcome.status,
          reused: true,
          card_id: card.id,
        },
      };
    case 'started':
      if (!outcome.runId) {
        return {
          httpStatus: 202,
          body: {
            ok: true,
            run_id: null,
            status: outcome.status,
            message: 'Finalize run started; row not yet visible.',
            card_id: card.id,
          },
        };
      }
      return {
        httpStatus: 200,
        body: {
          run_id: outcome.runId,
          status: outcome.status,
          reused: false,
          card_id: card.id,
        },
      };
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}
