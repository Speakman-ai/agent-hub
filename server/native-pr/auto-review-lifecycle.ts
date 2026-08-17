/**
 * Ephemeral auto-review sessions are archived (soft-deleted) when their single
 * background turn finishes. Both flavors `maybeRunPrAutoReview` dispatches are
 * covered: the automatic `external push` review for an unvalidated native PR
 * head, and the `requested` review a human triggers with "Request review".
 * Both are throwaway reviewer runs that must not linger on the dashboard once
 * the turn ends. Failures are recorded on the native PR as a `commented`
 * review before the session is removed from the live sidebar.
 */
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, Project, Stmts } from '../types.js';
import { findAgent } from '../project-model.js';

/**
 * Matches both ephemeral reviewer-session titles from `maybeRunPrAutoReview`
 * in auto-review.ts: `external push` (gate-driven) and `requested` (manual
 * "Request review" press). Capture group 1 is the PR number.
 */
export const AUTO_REVIEW_SESSION_TITLE_RE =
  /^\[Review PR #(\d+)\] (?:external push|requested) @ [0-9a-f]{8}$/i;

export function parseAutoReviewSessionTitle(
  sessionName: string | null | undefined,
): { prNumber: number } | null {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const m = sessionName.trim().match(AUTO_REVIEW_SESSION_TITLE_RE);
  if (!m) return null;
  const prNumber = Number.parseInt(m[1], 10);
  if (!Number.isFinite(prNumber) || prNumber < 1) return null;
  return { prNumber };
}

export interface FinalizeAutoReviewSessionArgs {
  sessionId: string;
  agentId: string;
  sessionName: string;
  /** When set, a `commented` review is posted on the PR before archival. */
  error?: string | null;
}

export interface AutoReviewLifecycleDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
}

/** Loads session title and delegates to {@link finalizeAutoReviewSession}. */
export function maybeFinalizeAutoReviewSession(
  deps: AutoReviewLifecycleDeps,
  args: { sessionId: string; agentId: string; error?: string | null },
): void {
  const session = deps.stmts.getSession.get(args.sessionId) as
    | { name?: string | null; deleted_at?: string | null }
    | undefined;
  if (!session?.name || session.deleted_at) return;
  finalizeAutoReviewSession(deps, {
    sessionId: args.sessionId,
    agentId: args.agentId,
    sessionName: session.name,
    error: args.error,
  });
}

/**
 * Resolve the project + reviewer display name for an auto-review session.
 * Returns null unless the agent exists, belongs to an Agent
 * Hub-hosted project, AND is a reviewer — archival is part of the reviewer
 * lifecycle contract, so a manually renamed non-reviewer session that happens
 * to match the title pattern must never be swept up.
 */
function resolveHostedReviewerForAgent(
  agentId: string,
): { project: Project; reviewerName: string } | null {
  const lookup = findAgent(agentId);
  if (!lookup) return null;
  const { project, agent } = lookup;
  if (project.gitHost !== 'agenthub') return null;
  if (agent.role !== 'reviewer') return null;
  const reviewerName = agent.name?.trim() || 'Reviewer';
  return { project, reviewerName };
}

function postAutoReviewFailureReview(
  deps: AutoReviewLifecycleDeps,
  project: Project,
  prNumber: number,
  reviewerName: string,
  error: string,
): void {
  const row = deps.stmts.getPullRequestByNumber.get(project.id, prNumber) as
    | { status: string }
    | undefined;
  if (!row || row.status !== 'open') return;

  const trimmed = error.trim().slice(0, 4000);
  const body =
    `**Auto-review failed**\n\n` +
    `The external-push review session exited before posting a verdict:\n\n` +
    '```\n' +
    (trimmed || '(no error detail)') +
    '\n```';

  const now = Date.now();
  deps.stmts.insertPullRequestReview.run(
    uuidv4(),
    project.id,
    prNumber,
    reviewerName,
    'commented',
    body,
    now,
  );
  deps.broadcast({
    type: 'native_pr_update',
    projectId: project.id,
    prNumber,
    action: 'reviewed',
    reviewState: 'commented',
  });
}

/**
 * Archive an ephemeral auto-review session (external-push or manually
 * requested). No-op for other session types. Never throws — chat turn teardown
 * must not fail because cleanup did.
 */
export function finalizeAutoReviewSession(
  deps: AutoReviewLifecycleDeps,
  args: FinalizeAutoReviewSessionArgs,
): void {
  try {
    const parsed = parseAutoReviewSessionTitle(args.sessionName);
    if (!parsed) return;

    const session = deps.stmts.getSession.get(args.sessionId) as
      | { deleted_at?: string | null }
      | undefined;
    if (!session || session.deleted_at) return;

    const resolved = resolveHostedReviewerForAgent(args.agentId);
    if (!resolved) return;
    const { project, reviewerName } = resolved;

    const errorText = args.error?.trim();
    if (errorText) {
      try {
        postAutoReviewFailureReview(deps, project, parsed.prNumber, reviewerName, errorText);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[auto-review] failed to post error review on ${project.id}#${parsed.prNumber}: ${msg}`,
        );
      }
    }

    try {
      const bgTask = deps.stmts.getBackgroundTaskBySession.get(args.sessionId) as
        | { id: string; status: string }
        | undefined;
      if (bgTask?.status === 'running') {
        const terminal = errorText ? 'error' : 'done';
        deps.stmts.updateBackgroundTaskStatus.run(terminal, bgTask.id);
        deps.broadcast({
          type: 'task_complete',
          taskId: bgTask.id,
          sessionId: args.sessionId,
          agentId: args.agentId,
          status: terminal,
        });
      }
    } catch {
      /* best-effort */
    }

    deps.stmts.softDeleteSession.run(args.sessionId);
    deps.broadcast({ type: 'session_deleted', sessionId: args.sessionId });
    console.log(
      `[auto-review] archived session ${args.sessionId} for ${project.id}#${parsed.prNumber}` +
        (errorText ? ' (after error)' : ''),
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[auto-review] session cleanup failed for ${args.sessionId}: ${msg}`);
  }
}
