/**
 * trigger-run.ts — shared Finalize run kickoff for card and session routes.
 */
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
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
import { normalizeJobFilter } from './finalize-keys.js';
import { buildOrchestratorDeps } from './orchestrator-deps.js';
import { getSessionCommittableChanges } from './worktree-changes.js';
import { resolveFinalizeBaseBranchForCard } from './resolve-base-branch.js';
import {
  createFinalizeRunSignal,
  registerFinalizeRunAbort,
  unregisterFinalizeRunAbort,
} from './run-abort-registry.js';

const execFileAsync = promisify(execFile);

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

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kickoffClaimKey(args: {
  sessionId: string;
  branch: string;
  jobFilterJson: string | null;
}): string {
  return createHash('sha256')
    .update(args.sessionId)
    .update('\0')
    .update(args.branch)
    .update('\0')
    .update(args.jobFilterJson ?? '')
    .digest('hex');
}

export type TriggerFinalizeRunResult =
  | { httpStatus: 200; body: { run_id: string; status: string; reused: boolean; card_id: string } }
  | {
      httpStatus: 202;
      body: { ok: true; run_id: null; status: string; message: string; card_id: string };
    }
  | { httpStatus: 409; body: { error: string; run_id: string; status: string; message: string } }
  | {
      httpStatus: 400;
      body: { error: string; message: string };
    };

export type StartFinalizeRunBackgroundResult =
  | { ok: true; runId: string; status: string }
  | { ok: false; error: string; runId?: string; message?: string };

async function kickoffFinalizeRun(
  deps: RouteDeps,
  args: {
    project: Project;
    card: KanbanCardRow;
    session: SessionRow;
    triggerSource: 'ui_button' | 'agent_block';
    triggeredByUserId: string;
    mode?: FinalizeRunMode;
    jobFilter?: string[] | null;
  },
): Promise<
  | { kind: 'started'; runId: string; status: string }
  | { kind: 'reused'; runId: string; status: string }
  | { kind: 'ready_to_push'; runId: string }
  | { kind: 'in_flight'; runId: string; status: string }
  | { kind: 'error'; error: string; message: string }
> {
  const { project, card, session } = args;
  const { stmts } = deps;
  // A job filter forces checks-scope (mirrors the orchestrator) so the early
  // idempotency probe below computes the same key the orchestrator will.
  const jobFilter = normalizeJobFilter(args.jobFilter);
  const mode: FinalizeRunMode = jobFilter ? 'checks' : (args.mode ?? 'full');

  if (!session.worktree_path) {
    return { kind: 'error', error: 'no_worktree', message: 'Session has no worktree_path.' };
  }
  if (!session.worktree_branch) {
    return { kind: 'error', error: 'no_branch', message: 'Session has no worktree_branch.' };
  }

  const committable = await getSessionCommittableChanges(session.worktree_path);
  if (!committable.ok) {
    return { kind: 'error', error: committable.error, message: committable.message };
  }

  let headSha: string;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: session.worktree_path,
      timeout: 30_000,
      maxBuffer: 1 * 1024 * 1024,
    });
    headSha = stdout.trim();
    if (!headSha) throw new Error('empty rev-parse output');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'error', error: 'no_head_sha', message: `Could not resolve HEAD: ${msg}` };
  }

  const idempotencyKey = computeIdempotencyKey({
    projectId: project.id,
    branch: session.worktree_branch,
    headSha,
    mode,
    jobFilter,
  });
  const existing = stmts.getFinalizeRunByIdempotencyKey.get(idempotencyKey) as
    | FinalizeRunRow
    | undefined;
  if (existing) {
    if (existing.status === 'ready_to_push') {
      return { kind: 'ready_to_push', runId: existing.id };
    }
    if (!TERMINAL_STATUSES.has(existing.status)) {
      return { kind: 'in_flight', runId: existing.id, status: existing.status };
    }
    return { kind: 'reused', runId: existing.id, status: existing.status };
  }

  const activeForBranch = stmts.getActiveFinalizeRunForSessionBranch.get(
    session.id,
    session.worktree_branch,
    jobFilter ? JSON.stringify(jobFilter) : null,
    jobFilter ? JSON.stringify(jobFilter) : null,
  ) as FinalizeRunRow | undefined;
  if (activeForBranch) {
    return { kind: 'in_flight', runId: activeForBranch.id, status: activeForBranch.status };
  }

  const jobFilterJson = jobFilter ? JSON.stringify(jobFilter) : null;
  const claimKey = kickoffClaimKey({
    sessionId: session.id,
    branch: session.worktree_branch,
    jobFilterJson,
  });
  stmts.pruneStaleFinalizeKickoffClaims.run(Date.now() - KICKOFF_CLAIM_TTL_MS);
  const claimResult = stmts.insertFinalizeKickoffClaim.run(
    claimKey,
    session.id,
    session.worktree_branch,
    mode,
    jobFilterJson,
    Date.now(),
  ) as { changes?: number };
  if ((claimResult.changes ?? 0) === 0) {
    for (let i = 0; i < ROW_VISIBILITY_POLL_MAX_ATTEMPTS; i++) {
      const active = stmts.getActiveFinalizeRunForSessionBranch.get(
        session.id,
        session.worktree_branch,
        jobFilterJson,
        jobFilterJson,
      ) as FinalizeRunRow | undefined;
      if (active) {
        return { kind: 'in_flight', runId: active.id, status: active.status };
      }
      await sleep(ROW_VISIBILITY_POLL_INTERVAL_MS);
    }
    return { kind: 'in_flight', runId: '', status: 'queued' };
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
      jobFilter,
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
      });

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
    jobFilter?: string[] | null;
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
    jobFilter: args.jobFilter,
  });

  switch (outcome.kind) {
    case 'error':
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
            'Checks already passed for this commit. Click **Push to GitHub** on the session, or cancel and re-run Finalize after new changes.',
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
