/**
 * Ephemeral external-push auto-review sessions are archived (soft-deleted)
 * when their single background turn finishes. Failures are recorded on the
 * native PR as a `commented` review before the session is removed from the
 * live sidebar.
 */
import { v4 as uuidv4 } from 'uuid';
import type { BroadcastFn, Project, Stmts } from '../types.js';
import { findAgent } from '../project-model.js';

/** Matches titles from `maybeRunPrAutoReview` in auto-review.ts. */
export const EXTERNAL_PUSH_AUTO_REVIEW_TITLE_RE =
  /^\[Review PR #(\d+)\] external push @ [0-9a-f]{8}$/i;

export function parseExternalPushAutoReviewTitle(
  sessionName: string | null | undefined,
): { prNumber: number } | null {
  if (sessionName == null || typeof sessionName !== 'string') return null;
  const m = sessionName.trim().match(EXTERNAL_PUSH_AUTO_REVIEW_TITLE_RE);
  if (!m) return null;
  const prNumber = Number.parseInt(m[1], 10);
  if (!Number.isFinite(prNumber) || prNumber < 1) return null;
  return { prNumber };
}

export interface FinalizeExternalPushAutoReviewArgs {
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

/** Loads session title and delegates to {@link finalizeExternalPushAutoReviewSession}. */
export function maybeFinalizeExternalPushAutoReviewSession(
  deps: AutoReviewLifecycleDeps,
  args: { sessionId: string; agentId: string; error?: string | null },
): void {
  const session = deps.stmts.getSession.get(args.sessionId) as
    | { name?: string | null; deleted_at?: string | null }
    | undefined;
  if (!session?.name || session.deleted_at) return;
  finalizeExternalPushAutoReviewSession(deps, {
    sessionId: args.sessionId,
    agentId: args.agentId,
    sessionName: session.name,
    error: args.error,
  });
}

/**
 * Resolve the project + reviewer display name for an external-push auto-review
 * session. Returns null unless the agent exists, belongs to an Agent
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
 * Archive an external-push auto-review session. No-op for other session types.
 * Never throws — chat turn teardown must not fail because cleanup did.
 */
export function finalizeExternalPushAutoReviewSession(
  deps: AutoReviewLifecycleDeps,
  args: FinalizeExternalPushAutoReviewArgs,
): void {
  try {
    const parsed = parseExternalPushAutoReviewTitle(args.sessionName);
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
