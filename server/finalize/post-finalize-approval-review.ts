/**
 * post-finalize-approval-review.ts — mirror a passing Finalize review onto
 * the native PR as an `approved` review.
 *
 * The bug this fixes: a session (typically a `[Resolve PR #N]` session) takes
 * a Hub-hosted PR that a reviewer had marked `changes_requested`, fixes it,
 * and runs through Finalize. Finalize's in-hub reviewer approves and the work
 * is pushed back to the PR branch — but nothing posted that approval onto the
 * PR itself. Worse, the auto-review safety net (`maybeRunPrAutoReview`)
 * deliberately skips Finalize-validated heads, so the PR sat at
 * `CHANGES_REQUESTED` forever even though it had passed review.
 *
 * After a gate-passing Finalize push to a native PR, we post an `approved`
 * review attributed to the project Reviewer agent (so it supersedes — by
 * reviewer name — any prior `changes_requested` that same reviewer left, per
 * `reviewDecisionFor`'s latest-per-reviewer precedence) and include the
 * reviewer's diff notes verbatim in the body.
 *
 * Only fires when the push actually cleared the review/checks gate
 * (`bypassedGates === false`): a forced / "push anyway" push did not pass
 * review and must not be laundered into an approval.
 */
import type {
  FinalizeRunRow,
  Project,
  ReviewerThreadRow,
  RouteDeps,
  SessionRow,
} from '../types.js';
import { parseNativePrUrl } from '../native-pr/url.js';
import { formatThreadsForDispatchBody } from './reviewer-dispatch.js';

export interface PostFinalizeApprovalReviewArgs {
  deps: Pick<RouteDeps, 'stmts' | 'nativePr'>;
  project: Project;
  run: FinalizeRunRow;
  session: SessionRow;
  /** PR URL returned by the push step. */
  prUrl: string;
  /** True when the push skipped the review/checks gate (force / "push anyway"). */
  bypassedGates: boolean;
}

/** Compose the approval review body from the reviewer's diff notes. */
export function buildApprovalReviewBody(threads: ReviewerThreadRow[]): string {
  const header =
    'Approved by Finalize review — the change passed the in-hub reviewer and CI checks before this push.';
  const notes = formatThreadsForDispatchBody(threads);
  return notes ? `${header}\n\n${notes}` : header;
}

/**
 * Post the Finalize approval onto the native PR. Best-effort: returns whether
 * a review was posted and never throws (a failure here must not fail the
 * push that already succeeded).
 */
export function postFinalizeApprovalReview(args: PostFinalizeApprovalReviewArgs): boolean {
  const { deps, project, run, session, prUrl, bypassedGates } = args;
  try {
    // A push that skipped the gate did not pass review — nothing to mirror.
    if (bypassedGates) return false;
    if (project.gitHost !== 'agenthub') return false;
    if (!deps.nativePr) return false;

    const parsed = parseNativePrUrl(prUrl);
    if (!parsed || parsed.projectId !== project.id) return false;

    // Attribute the approval to the project Reviewer agent so it supersedes
    // (by reviewer name) any prior changes_requested that same reviewer left.
    // Without a reviewer agent we cannot post under a name that supersedes the
    // stale verdict, so there is nothing useful to do.
    const reviewer = (project.agents || []).find((a) => a.role === 'reviewer');
    if (!reviewer) return false;

    // Resolve the verdict from the review phase; only mirror a real approval.
    // (A non-forced push only happens after the push gate accepts an approved
    // verdict, but resolve defensively so a future caller can't launder a
    // changes_requested verdict into an approval.)
    const reviewRun = deps.stmts.getLatestReviewRunForSession.get(session.id) as
      | FinalizeRunRow
      | undefined;
    const verdict = reviewRun?.reviewer_verdict ?? run.reviewer_verdict ?? null;
    if (verdict !== 'approved') return false;

    const threads = reviewRun
      ? (deps.stmts.listReviewerThreadsForRun.all(reviewRun.id) as ReviewerThreadRow[])
      : [];

    deps.nativePr.submitReview({
      project,
      number: parsed.number,
      state: 'approved',
      body: buildApprovalReviewBody(threads),
      reviewer: reviewer.name?.trim() || 'Reviewer',
    });
    console.log(
      `[finalize-push] posted approved review on ${project.id}#${parsed.number} for run=${run.id}`,
    );
    return true;
  } catch (err: unknown) {
    console.warn(
      `[finalize-push] post-approval review failed for run=${run.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}
