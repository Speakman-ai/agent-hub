/**
 * service.ts — NativePrService: the single in-process API for native
 * pull requests. Both the REST routes (pr-list/pr-actions branching) and
 * the Finalize push step call THIS, never the store/git layers directly.
 *
 * Response shapes deliberately mirror the GitHub REST normalizations in
 * routes/pr-list.ts (`normalizePrSummary`) so `PullRequestsPage.jsx`
 * renders native PRs unmodified: `merged` maps to `state: 'closed'` +
 * `merged_at` set (GitHub REST semantics), timestamps are ISO strings,
 * and `html_url` is the native client route from `url.ts`.
 */

import type { BroadcastFn, Project, PullRequestRow, Stmts } from '../types.js';
import { bareRepoPath, hostedRepoExists, isAgentHubHosted } from './host.js';
import { isDevServerConfigured } from '../dev-server-config.js';
import { buildNativePrUrl } from './url.js';
import { matchEpicForPrBranches, type EpicBranchRef, type LinkedEpic } from './epic-branch-link.js';
import {
  createOrGetOpenPullRequest,
  getPullRequest,
  listPullRequests,
  listPullRequestsForBranch,
  markClosed,
  markMerged,
  markReverted,
  type PrListState,
} from './store.js';
import {
  mergeTree,
  prCommits,
  prDiff,
  prDiffStat,
  prFiles,
  revParse,
  type PrCommitEntry,
  type PrFileEntry,
} from './git-read.js';
import { hostedRepoDefaultBranch } from '../git-host/repo-store.js';
import { parseCiConfig } from '../finalize/ci-config.js';
import { expandJobInstances } from '../finalize/ci-config-jobs.js';
import { isKnownHubUserId } from './author-user.js';
import { NativePrError } from './errors.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mapWithConcurrency } from '../git-host/recent-pushes.js';

const execFileP = promisify(execFile);
const LIST_MERGEABILITY_CONCURRENCY = 4;

async function ciConfigTextAtCommit(repoPath: string, sha: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'show', `${sha}:.agent-hub/ci.yaml`],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    return stdout;
  } catch {
    return null;
  }
}

/**
 * Why are there no checks on this PR? Read the ci.yaml at the head sha
 * and explain the empty state — "No checks reported" with no reason is
 * how "CI didn't run" support mysteries happen.
 */
async function ciEmptyStateNote(repoPath: string, sha: string): Promise<string | null> {
  const text = await ciConfigTextAtCommit(repoPath, sha);
  if (text === null) {
    return 'No CI is configured on this branch (.agent-hub/ci.yaml not found).';
  }
  const parsed = parseCiConfig(text);
  if (!parsed.ok) {
    return `.agent-hub/ci.yaml failed to parse: ${parsed.error.message}`;
  }
  return 'Checks have not started yet for the head commit.';
}
import { mergePullRequest, type MergeMethod } from './merge.js';
import { tryAutoMergeArmedNativePr } from './auto-merge-armed.js';
import { revertPullRequest } from './revert.js';
import { handleCardOnMerge } from './card-on-merge.js';

export { NativePrError } from './errors.js';

export interface NativePrServiceDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /**
   * Fired after this service moves a base branch with `update-ref` — merging
   * a PR or reverting a merged one. `update-ref` bypasses `post-receive`, so
   * this hook is the only thing that tells the hosting layer the branch moved
   * (GitHub mirror push, push CI, deploy triggers). Fired and forgotten; a
   * mirror failure never rolls back the git write that already landed.
   */
  afterBaseBranchMoved?: (args: {
    project: Project;
    baseBranch: string;
    sha: string;
    reason: 'merge' | 'revert';
  }) => Promise<void>;
  /**
   * Fired when a PR is created or an open PR is reused with a fresh head sha.
   * Fire-and-forget. The reason lets consumers distinguish PR creation from a
   * later head update; credential-sensitive consumers must not treat both as
   * PR-author-owned work.
   */
  onPrHeadChanged?: (
    project: Project,
    row: PullRequestRow,
    meta: { reason: 'created' | 'head_updated' },
  ) => void;
  /**
   * Fired after a PR merges, so per-PR side effects that key off the head
   * branch can run. Used to tear down a PR preview (the worktree preview for
   * the session that owns the head branch) — a merged PR's preview should not
   * linger until the idle reaper catches it. Fire-and-forget; a teardown
   * failure never rolls back the merge that already landed in git.
   */
  afterPrMerged?: (args: { project: Project; row: PullRequestRow }) => void;
  /**
   * Resolve whether a live session worktree still backs a PR's head branch.
   * A PR's preview is the worktree preview for the session that owns its head
   * branch; once that session is archived/deleted the worktree is gone and
   * `POST /preview/start` 409s. `getDetail` surfaces the result as
   * `preview_session_available` so the client can gate the Enable-preview
   * affordance instead of offering a button that only errors. When omitted
   * (e.g. in tests), the field defaults to `preview_available` — the prior
   * behavior — so wiring it is what activates the extra gate.
   */
  hasLivePreviewSession?: (project: Project, headBranch: string) => boolean;
}

export interface NativePrService {
  createOrGetOpenPr(args: {
    project: Project;
    headBranch: string;
    baseBranch: string;
    headSha: string;
    title: string;
    body: string;
    author: string;
  }): { row: PullRequestRow; prUrl: string; created: boolean };
  listPulls(args: {
    project: Project;
    state: PrListState;
    limit: number;
    /** Rows to skip for offset pagination (page N → (N-1) * pageSize). Defaults to 0. */
    offset?: number;
  }): Promise<Array<Record<string, unknown>>>;
  /**
   * All PRs (any state) whose base or head branch equals `branch`, summarized.
   * Filtered in storage (no page limit) — used by the epic-pulls endpoint so a
   * feature branch's PRs are never paged out. Includes `linked_epic`.
   */
  listPullsForBranch(args: { project: Project; branch: string }): Array<Record<string, unknown>>;
  getDetail(args: { project: Project; number: number }): Promise<{
    source: 'agenthub';
    pr: Record<string, unknown>;
    reviews: Array<Record<string, unknown>>;
    /** Inline comments folded into issue-comment shape (timeline + autofix context). */
    comments: Array<Record<string, unknown>>;
    /** Check-run rows from the latest CI-bearing run for the head sha. */
    checks: Array<Record<string, unknown>>;
    /** Why the checks array is empty (v1 config, no config, not started); null when checks exist. */
    checks_note: string | null;
    /** Backing push/pr-ci run (re-run target); null for Finalize-run checks. */
    ci_run: { id: string; trigger_source: string; status: string } | null;
    /**
     * The latest CI-bearing run for the head sha, regardless of trigger
     * (Finalize, branch push CI, PR CI), carrying its job rows so the PR
     * page can render the same expandable Run → Job → Step view as the
     * Runners "Recent runs" list. Null when no run exists for the head.
     * Distinct from `ci_run`, which only points at re-runnable push/pr-ci
     * runs and drives the Re-run buttons.
     */
    checks_run: DisplayRun | null;
    headSha: string | null;
    commits: PrCommitEntry[];
    /** Raw inline diff comments for in-diff rendering. */
    inline_comments: Array<Record<string, unknown>>;
    /** True when the project has a dev server configured (preview control shown). */
    preview_available: boolean;
    /** Project opts every PR into showing preview state by default. */
    preview_default_on: boolean;
    /**
     * True when a live session worktree still backs this PR's head branch, so a
     * preview can actually be launched. False once the owning session is
     * archived/deleted — the Enable-preview control would otherwise 409.
     */
    preview_session_available: boolean;
  }>;
  /** Guarded closed → open transition (merged PRs are immutable). */
  reopen(args: { project: Project; number: number }): { row: PullRequestRow };
  /** Set or clear the human review-request flag. */
  setReviewRequested(args: {
    project: Project;
    number: number;
    requested: boolean;
    actor: string;
  }): { row: PullRequestRow };
  /**
   * Arm or disarm auto-merge on an open PR. Armed PRs merge once the head's
   * checks pass and the PR is otherwise mergeable — the completion is driven
   * by the checks-passed hook (and an immediate attempt when already green).
   */
  setAutoMerge(args: { project: Project; number: number; enabled: boolean }): {
    row: PullRequestRow;
  };
  /** Record a human review; approve/changes-requested clears the request flag. */
  submitReview(args: {
    project: Project;
    number: number;
    state: 'approved' | 'changes_requested' | 'commented';
    body: string;
    reviewer: string;
    /**
     * Acting session id of the submitter. When it matches the PR's
     * agent_review_session_id (the dispatched Reviewer session that owns the
     * in-flight claim), a verdict clears that claim. Absent / non-owning
     * submitters (a human, or a stale reviewer session after TTL reclamation)
     * never clear it.
     */
    sessionId?: string | null;
  }): { review: Record<string, unknown> };
  /**
   * Dismiss a submitted verdict review (GitHub "Dismiss review"). The row is
   * kept for history but its verdict stops counting toward the review
   * decision, and it renders collapsed with the dismissal note. Only
   * approved / changes_requested reviews can be dismissed; a comment review
   * has no verdict to dismiss. Allowed on closed/merged PRs.
   */
  dismissReview(args: {
    project: Project;
    number: number;
    reviewId: string;
    reason: string;
    actor: string;
  }): { review: Record<string, unknown> };
  /** Inline (per-line) diff comment anchored to file + line + side. */
  addInlineComment(args: {
    project: Project;
    number: number;
    filePath: string;
    line: number;
    side: 'old' | 'new';
    body: string;
    author: string;
  }): { comment: Record<string, unknown> };
  /** Delete an inline comment (route enforces author/ownership policy). */
  deleteInlineComment(args: { project: Project; number: number; commentId: string }): void;
  /**
   * Resolve or unresolve the comment thread anchored at file + line + side.
   * Allowed on closed/merged PRs so reviewers can still tidy up a finished
   * review; 404s when no comment is anchored there.
   */
  setCommentThreadResolved(args: {
    project: Project;
    number: number;
    filePath: string;
    line: number;
    side: 'old' | 'new';
    resolved: boolean;
    actor: string;
  }): { thread: Record<string, unknown> };
  diff(args: { project: Project; number: number }): Promise<{ source: 'agenthub'; diff: string }>;
  files(args: {
    project: Project;
    number: number;
  }): Promise<{ source: 'agenthub'; files: PrFileEntry[] }>;
  merge(args: {
    project: Project;
    number: number;
    mergeMethod: MergeMethod;
    actor: string;
  }): Promise<
    | { ok: true; mergedSha: string }
    | { ok: false; status: number; error: string; mergeable?: false }
  >;
  /**
   * Undo a merged PR by committing its inverse on the base branch. Adds a
   * commit rather than rewriting history — see revert.ts for why. Once only:
   * a PR that already carries a `revert_sha` is refused.
   */
  revert(args: {
    project: Project;
    number: number;
    actor: string;
  }): Promise<{ ok: true; revertSha: string } | { ok: false; status: number; error: string }>;
  close(args: { project: Project; number: number }): { row: PullRequestRow };
}

function toIso(epochMs: number | null): string | null {
  return epochMs === null ? null : new Date(epochMs).toISOString();
}

/** GitHub-summary-shape mapping (see module header). */
function summarize(
  projectId: string,
  row: PullRequestRow,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.status === 'open' ? 'open' : 'closed',
    merged: row.status === 'merged',
    draft: false,
    html_url: buildNativePrUrl(projectId, row.number),
    user: row.author,
    user_avatar: null,
    head: row.head_branch,
    base: row.base_branch,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    merged_at: toIso(row.merged_at),
    closed_at: toIso(row.closed_at ?? row.merged_at),
    labels: [],
    comments: 0,
    review_comments: 0,
    mergeable: null,
    mergeable_state: null,
    merge_state_status: null,
    review_decision: null,
    check_rollup: null,
    review_requested: row.review_requested_at !== null && row.review_requested_at !== undefined,
    review_requested_by: row.review_requested_by ?? null,
    agent_review_requested:
      row.agent_review_requested_at !== null && row.agent_review_requested_at !== undefined,
    reverted: row.revert_sha !== null && row.revert_sha !== undefined,
    revert_sha: row.revert_sha ?? null,
    reverted_at: toIso(row.reverted_at ?? null),
    reverted_by: row.reverted_by ?? null,
    // Native PR auto-merge arming (boolean; the GitHub path surfaces an
    // `auto_merge` object instead — the client toggle handles both shapes).
    auto_merge: row.auto_merge === 1,
    ...extra,
  };
}

/**
 * Check-run rows (GitHub shape) for a commit, merged across ALL its runs
 * — newest result wins per (job, matrix). Per-job re-runs create runs
 * holding a single job, so reading only the latest run would make the
 * other checks vanish; merging keeps every check visible with its most
 * recent verdict (GitHub's per-check-name semantics). Finalize runs,
 * branch push-CI, and PR-level CI all surface identically.
 */
function checksForSha(
  stmts: Stmts,
  projectId: string,
  sha: string,
): Array<Record<string, unknown>> {
  const runs = stmts.listFinalizeRunsForSha.all(projectId, sha, sha) as Array<{
    id: string;
    trigger_source: string;
    status: string;
    failure_reason: string | null;
  }>;
  if (runs.length === 0) return [];

  const byJob = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    // newest → oldest: first occurrence of a job key wins
    const jobs = stmts.listFinalizeRunJobsForRun.all(run.id) as Array<{
      job_id: string;
      matrix_key: string;
      state: string;
      started_at: number | null;
      ended_at: number | null;
    }>;
    const prefix =
      run.trigger_source === 'pr_push' || run.trigger_source === 'git_push' ? 'ci' : 'finalize';
    for (const j of jobs) {
      const key = `${j.job_id} ${j.matrix_key}`;
      if (byJob.has(key)) continue;
      const status =
        j.state === 'queued' ? 'queued' : j.state === 'running' ? 'in_progress' : 'completed';
      const conclusion =
        j.state === 'passed'
          ? 'success'
          : j.state === 'failed'
            ? 'failure'
            : j.state === 'skipped'
              ? 'skipped'
              : null;
      byJob.set(key, {
        id: `${run.id}:${j.job_id}:${j.matrix_key}`,
        name: `${prefix}/${j.job_id}${j.matrix_key ? ` (${j.matrix_key})` : ''}`,
        status,
        conclusion,
        html_url: null,
        started_at: toIso(j.started_at),
        completed_at: toIso(j.ended_at),
        // Re-run plumbing (client buttons) — only CI-engine runs re-run here.
        run_id: run.id,
        job_id: j.job_id,
        matrix_key: j.matrix_key,
      });
    }
  }

  const merged = [...byJob.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));

  // A LATEST run that died before producing any job rows (invalid
  // ci.yaml, clone/infra failure) must still SHOW on the PR — silence
  // here is how "CI didn't run" mysteries happen. Older runs' jobs stay
  // listed below it for context.
  const latest = runs[0];
  const latestHasJobs = merged.some((c) => c.run_id === latest.id);
  if (!latestHasJobs && latest.status === 'failed') {
    merged.unshift({
      id: `${latest.id}:setup`,
      name: `ci/setup (${latest.failure_reason ?? 'failed'})`,
      status: 'completed',
      conclusion: 'failure',
      html_url: null,
      started_at: null,
      completed_at: null,
    });
  }
  return merged;
}

/** The CI run backing the checks rows, when re-runnable (push / pr ci). */
function ciRunForSha(
  stmts: Stmts,
  projectId: string,
  sha: string,
): { id: string; trigger_source: string; status: string } | null {
  const run = stmts.getLatestFinalizeRunForSha.get(projectId, sha, sha) as
    | { id: string; trigger_source: string; status: string }
    | undefined;
  if (!run) return null;
  if (run.trigger_source !== 'git_push' && run.trigger_source !== 'pr_push') return null;
  return { id: run.id, trigger_source: run.trigger_source, status: run.status };
}

interface DisplayRunJob {
  job_id: string;
  matrix_key: string;
  state: string;
  exit_code: number | null;
  started_at: number | null;
  ended_at: number | null;
}

interface DisplayRun {
  id: string;
  branch: string | null;
  head_sha: string | null;
  status: string;
  trigger_source: string;
  failure_reason: string | null;
  started_at: number | null;
  ended_at: number | null;
  session_id: string | null;
  session_title: string | null;
  jobs: DisplayRunJob[];
}

/**
 * The latest CI-bearing run for a commit (any trigger) shaped for the PR
 * page's expandable RunRow — same fields the `/ci-runs` list endpoint
 * serializes (incl. `jobs` so the Run → Job → Step grouping renders).
 * Unlike `ciRunForSha` it is NOT trigger-filtered: a Finalize-validated
 * PR surfaces its run here so the per-job/per-step detail shows up instead
 * of the flat check list.
 */
function displayRunForSha(stmts: Stmts, projectId: string, sha: string): DisplayRun | null {
  const run = stmts.getLatestFinalizeRunForSha.get(projectId, sha, sha) as
    | {
        id: string;
        branch: string | null;
        head_sha: string | null;
        status: string;
        trigger_source: string;
        failure_reason: string | null;
        started_at: number | null;
        ended_at: number | null;
        session_id: string | null;
      }
    | undefined;
  if (!run) return null;
  const jobs = stmts.listFinalizeRunJobsForRun.all(run.id) as DisplayRunJob[];
  let sessionTitle: string | null = null;
  if (run.session_id) {
    const session = stmts.getSession.get(run.session_id) as { name?: string | null } | undefined;
    sessionTitle = session?.name ?? null;
  }
  return {
    id: run.id,
    branch: run.branch,
    head_sha: run.head_sha,
    status: run.status,
    trigger_source: run.trigger_source,
    failure_reason: run.failure_reason,
    started_at: run.started_at,
    ended_at: run.ended_at,
    session_id: run.session_id,
    session_title: sessionTitle,
    jobs,
  };
}

function requiredChecksBlockReasonFromRows(
  checks: Array<Record<string, unknown>>,
  requiredJobs: Array<{ jobId: string; matrixKey: string }> | null = null,
): string | null {
  if (checks.length === 0) {
    return 'Branch protection: checks have not run for the head commit yet.';
  }
  if (requiredJobs && requiredJobs.length > 0) {
    const checkedJobs = new Set(
      checks
        .map((c) => {
          if (typeof c.job_id !== 'string') return null;
          const matrixKey = typeof c.matrix_key === 'string' ? c.matrix_key : '';
          return `${c.job_id}\0${matrixKey}`;
        })
        .filter((jobKey): jobKey is string => jobKey !== null),
    );
    const missing = requiredJobs.filter(
      (job) => !checkedJobs.has(`${job.jobId}\0${job.matrixKey}`),
    );
    if (missing.length > 0) {
      return 'Branch protection: checks have not run for every required job on the head commit yet.';
    }
  }
  if (
    checks.some((c) => {
      const status = String(c.status ?? '').toLowerCase();
      return status === 'queued' || status === 'in_progress';
    })
  ) {
    return 'Branch protection: checks are still running for the head commit.';
  }
  const allPassing = checks.every((c) => {
    const conclusion = String(c.conclusion ?? '').toLowerCase();
    return conclusion === 'success' || conclusion === 'skipped' || conclusion === 'neutral';
  });
  return allPassing
    ? null
    : 'Branch protection: checks failed for the head commit — fix and re-run before merging.';
}

function requiredJobsFromCiConfigText(
  text: string,
): Array<{ jobId: string; matrixKey: string }> | null {
  const parsed = parseCiConfig(text);
  if (!parsed.ok) return null;
  return expandJobInstances(parsed.config, {}).map((instance) => ({
    jobId: instance.jobId,
    matrixKey: instance.matrixKey,
  }));
}

/**
 * Branch-protection merge gate for PRs targeting the protected (default)
 * branch. Returns a human-readable block reason, or null when the merge
 * may proceed. Finalize validation (review + checks on the exact head
 * sha) satisfies BOTH requirements — that's the session-validation
 * passthrough.
 */
async function mergeBlockedReason(
  stmts: Stmts,
  project: Project,
  row: PullRequestRow,
  repoPath: string,
): Promise<string | null> {
  const prot = project.branchProtection;
  if (!prot || (!prot.requiredChecks && !prot.requiredReview)) return null;
  const defaultBranch = (await hostedRepoDefaultBranch(project.id)) ?? 'main';
  if (row.base_branch !== defaultBranch) return null; // protection covers the default branch

  const headSha = (await revParse(repoPath, `refs/heads/${row.head_branch}`)) ?? row.head_sha;
  const validated = Boolean(stmts.getValidatedFinalizeRunForSha.get(project.id, headSha));

  if (prot.requiredReview && !validated) {
    const decision = reviewDecisionFor(stmts, project.id, row);
    if (decision === 'CHANGES_REQUESTED') {
      return 'Branch protection: a reviewer requested changes — resolve the review before merging.';
    }
    if (decision !== 'APPROVED') {
      return 'Branch protection: an approving review (or Finalize validation) is required to merge.';
    }
  }

  if (prot.requiredChecks && !validated) {
    // No ci.yaml at the head commit → the requirement is vacuous (there
    // is nothing configured to run).
    const ciConfigText = await ciConfigTextAtCommit(repoPath, headSha);
    if (ciConfigText !== null) {
      const checks = checksForSha(stmts, project.id, headSha);
      const blocked = requiredChecksBlockReasonFromRows(
        checks,
        requiredJobsFromCiConfigText(ciConfigText),
      );
      if (blocked) return blocked;
    }
  }

  return null;
}

/** Kanban card linked to this PR (cards store pr_url on link/ship). */
function linkedCardFor(
  stmts: Stmts,
  projectId: string,
  number: number,
): { id: string; title: string; column_id: string | null } | null {
  const card = stmts.getKanbanCardByPrUrl.get(buildNativePrUrl(projectId, number)) as
    | { id: string; title: string; column_id: string | null }
    | undefined;
  return card ? { id: card.id, title: card.title, column_id: card.column_id ?? null } : null;
}

/**
 * Feature-branch epics for a project, loaded ONCE per list/detail operation.
 * `linkedEpicForRow` matches individual PR rows against this set — callers must
 * not reload it per row (the list endpoint maps up to 200 PRs).
 */
function epicsForProject(stmts: Stmts, projectId: string): EpicBranchRef[] {
  const board = stmts.getKanbanBoard.get(projectId) as { id: string } | undefined;
  if (!board) return [];
  return stmts.getKanbanEpics.all(board.id) as EpicBranchRef[];
}

/**
 * Epic whose feature branch (`pr_base_branch`) matches this PR's base or head
 * branch, if any. Pure over a pre-loaded epic set — see `epicsForProject`.
 */
function linkedEpicForRow(epics: EpicBranchRef[], row: PullRequestRow): LinkedEpic | null {
  return matchEpicForPrBranches(epics, { head: row.head_branch, base: row.base_branch });
}

/** Anchor key shared by the comment rows and the thread-resolution rows. */
function threadKey(filePath: string, line: number | string, side: string): string {
  return `${side} ${line} ${filePath}`;
}

interface CommentThreadRow {
  file_path: string;
  line: number;
  side: string;
  resolved_by: string;
  resolved_at: number;
}

function resolvedThreads(
  stmts: Stmts,
  projectId: string,
  number: number,
): Map<string, CommentThreadRow> {
  const rows = stmts.listPullRequestCommentThreadsForPr.all(
    projectId,
    number,
  ) as CommentThreadRow[];
  return new Map(rows.map((r) => [threadKey(r.file_path, r.line, r.side), r]));
}

/**
 * Inline diff comments, raw (for in-diff rendering) and folded. Each comment
 * carries its thread's resolution so the diff view can collapse a resolved
 * anchor without a second round trip — resolution itself is stored per
 * thread, not per comment.
 */
function inlineComments(
  stmts: Stmts,
  projectId: string,
  number: number,
): Array<Record<string, unknown>> {
  const rows = stmts.listPullRequestCommentsForPr.all(projectId, number) as Array<{
    id: string;
    author: string;
    file_path: string;
    line: number;
    side: string;
    body: string;
    created_at: number;
  }>;
  const threads = resolvedThreads(stmts, projectId, number);
  return rows.map((r) => {
    const thread = threads.get(threadKey(r.file_path, r.line, r.side));
    return {
      id: r.id,
      user: r.author,
      file_path: r.file_path,
      line: r.line,
      side: r.side,
      body: r.body,
      created_at: toIso(r.created_at),
      resolved: Boolean(thread),
      resolved_by: thread?.resolved_by ?? null,
      resolved_at: thread ? toIso(thread.resolved_at) : null,
    };
  });
}

/** Human reviews in the GitHub review-object shape the client renders. */
function normalizedReviews(
  stmts: Stmts,
  projectId: string,
  number: number,
): Array<Record<string, unknown>> {
  const rows = stmts.listPullRequestReviewsForPr.all(projectId, number) as Array<{
    id: string;
    reviewer: string;
    state: string;
    body: string;
    created_at: number;
    dismissed_at: number | null;
    dismissed_by: string | null;
    dismissal_reason: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    user: r.reviewer,
    state: r.state.toUpperCase(), // APPROVED / CHANGES_REQUESTED / COMMENTED
    body: r.body,
    submitted_at: toIso(r.created_at),
    html_url: null,
    // GitHub "Dismiss review": a dismissed verdict stays in history but no
    // longer counts, and renders collapsed with the dismissal note.
    dismissed: Boolean(r.dismissed_at),
    dismissed_by: r.dismissed_by ?? null,
    dismissed_at: r.dismissed_at ? toIso(r.dismissed_at) : null,
    dismissal_reason: r.dismissal_reason ?? null,
  }));
}

import { reviewDecisionFor } from './review-decision.js';

function requireHostedRepo(project: Project): string {
  if (!isAgentHubHosted(project)) {
    throw new NativePrError('Project is not Agent Hub-hosted', 400);
  }
  if (!hostedRepoExists(project.id)) {
    throw new NativePrError('Hosted repo not found for project', 404);
  }
  return bareRepoPath(project.id);
}

function requirePr(stmts: Stmts, project: Project, number: number): PullRequestRow {
  const row = getPullRequest(stmts, project.id, number);
  if (!row) throw new NativePrError(`PR #${number} not found`, 404);
  return row;
}

export function createNativePrService(deps: NativePrServiceDeps): NativePrService {
  const { stmts, broadcast } = deps;

  const fireBaseBranchMoved = (
    project: Project,
    number: number,
    baseBranch: string,
    sha: string,
    reason: 'merge' | 'revert',
  ): void => {
    if (!deps.afterBaseBranchMoved) return;
    void deps.afterBaseBranchMoved({ project, baseBranch, sha, reason }).catch((err: unknown) => {
      console.warn(
        `[native-pr] afterBaseBranchMoved (${reason}) hook failed for ${project.id}#${number}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  };

  const service: NativePrService = {
    createOrGetOpenPr({ project, headBranch, baseBranch, headSha, title, body, author }) {
      requireHostedRepo(project);
      if (!isKnownHubUserId(author)) {
        throw new NativePrError('Pull request author must be a Hub user id', 400);
      }
      const { row, created } = createOrGetOpenPullRequest(stmts, {
        projectId: project.id,
        headBranch,
        baseBranch,
        headSha,
        title,
        body,
        author,
      });
      const prUrl = buildNativePrUrl(project.id, row.number);
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: row.number,
        action: created ? 'opened' : 'updated',
      });
      try {
        deps.onPrHeadChanged?.(project, row, { reason: created ? 'created' : 'head_updated' });
      } catch {
        /* CI trigger must never fail PR creation */
      }
      // A brand-new PR that consumed a pending `git push -o automerge` intent is
      // armed (auto_merge=1) but has no completing event of its own: if the
      // head's CI already finished green BEFORE the PR existed, the
      // checks-passed hook already ran and will not fire again. Attempt the
      // merge now — best-effort and detached, so it never fails PR creation. If
      // checks are still running / the PR is not yet mergeable, merge() returns
      // 409 and the PR stays armed for the checks-passed hook to complete.
      if (created && row.auto_merge === 1) {
        void tryAutoMergeArmedNativePr(
          { stmts, nativePr: service },
          { project, number: row.number },
        ).catch((err: unknown) => {
          console.warn(
            `[native-pr] intent auto-merge attempt failed for ${prUrl}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
      return { row, prUrl, created };
    },

    async listPulls({ project, state, limit, offset = 0 }) {
      if (!isAgentHubHosted(project)) {
        throw new NativePrError('Project is not Agent Hub-hosted', 400);
      }
      // Load the board's feature-branch epics once, not per row.
      const epics = epicsForProject(stmts, project.id);
      const repoPath = bareRepoPath(project.id);
      const rows = listPullRequests(stmts, project.id, state, limit, offset);
      return mapWithConcurrency(rows, LIST_MERGEABILITY_CONCURRENCY, async (row) => {
        let mergeable: boolean | null = null;
        let blockedReason: string | null = null;
        if (row.status === 'open') {
          const [baseSha, headSha] = await Promise.all([
            revParse(repoPath, `refs/heads/${row.base_branch}`),
            revParse(repoPath, `refs/heads/${row.head_branch}`),
          ]);
          if (baseSha && headSha) {
            try {
              mergeable = (await mergeTree(repoPath, baseSha, headSha)).mergeable;
            } catch {
              // Keep the tri-state unknown on an infrastructure/git failure.
            }
          }
          blockedReason = await mergeBlockedReason(stmts, project, row, repoPath);
        }
        return summarize(project.id, row, {
          mergeable,
          merge_blocked_reason: blockedReason,
          review_decision: reviewDecisionFor(stmts, project.id, row),
          // CI status badge on list rows. Uses the recorded head_sha (no
          // per-row git call); the detail view resolves the live head.
          check_rollup: checksForSha(stmts, project.id, row.head_sha),
          linked_card: linkedCardFor(stmts, project.id, row.number),
          linked_epic: linkedEpicForRow(epics, row),
        });
      });
    },

    listPullsForBranch({ project, branch }) {
      if (!isAgentHubHosted(project)) {
        throw new NativePrError('Project is not Agent Hub-hosted', 400);
      }
      // Load the board's feature-branch epics once, not per row.
      const epics = epicsForProject(stmts, project.id);
      return listPullRequestsForBranch(stmts, project.id, branch).map((row) =>
        summarize(project.id, row, {
          linked_epic: linkedEpicForRow(epics, row),
        }),
      );
    },

    async getDetail({ project, number }) {
      const repoPath = requireHostedRepo(project);
      const row = requirePr(stmts, project, number);

      let mergeable: boolean | null = null;
      let stat = { additions: 0, deletions: 0, changedFiles: 0 };
      let commits: PrCommitEntry[] = [];
      let headSha: string | null = row.status === 'open' ? null : row.head_sha;

      const baseSha =
        row.status === 'open' ? await revParse(repoPath, `refs/heads/${row.base_branch}`) : null;
      const liveHead =
        row.status === 'open' ? await revParse(repoPath, `refs/heads/${row.head_branch}`) : null;
      if (row.status === 'open' && baseSha && liveHead) {
        headSha = liveHead;
        try {
          const tree = await mergeTree(repoPath, baseSha, liveHead);
          mergeable = tree.mergeable;
        } catch {
          mergeable = null; // computation failed — suppress the badge
        }
        try {
          [stat, commits] = await Promise.all([
            prDiffStat(repoPath, baseSha, liveHead),
            prCommits(repoPath, baseSha, liveHead),
          ]);
        } catch {
          /* stat/commits stay at defaults */
        }
      }

      const inline = inlineComments(stmts, project.id, number);
      // Session-validation passthrough: a head sha that a Finalize run
      // fully validated (review + checks) flags the PR instead of
      // re-running anything; unvalidated heads show whatever PR-level CI
      // produced (or nothing yet).
      const statusSha = headSha ?? row.head_sha;
      const finalizeValidated = Boolean(
        stmts.getValidatedFinalizeRunForSha.get(project.id, statusSha),
      );
      // Surface the protection verdict so the Merge button disables with
      // the same reason the merge endpoint would 409 with.
      const blockedReason =
        row.status === 'open' ? await mergeBlockedReason(stmts, project, row, repoPath) : null;
      const checks = checksForSha(stmts, project.id, statusSha);
      const previewAvailable = isDevServerConfigured(project.prEnv?.devServer);
      return {
        source: 'agenthub' as const,
        pr: summarize(project.id, row, {
          mergeable,
          additions: stat.additions,
          deletions: stat.deletions,
          changed_files: stat.changedFiles,
          review_decision: reviewDecisionFor(stmts, project.id, row),
          finalize_validated: finalizeValidated,
          merge_blocked_reason: blockedReason,
          linked_card: linkedCardFor(stmts, project.id, row.number),
          linked_epic: linkedEpicForRow(epicsForProject(stmts, project.id), row),
        }),
        reviews: normalizedReviews(stmts, project.id, number),
        // Fold inline comments into the issue-comment shape so the
        // activity timeline shows them and the Autofix prompt context
        // (which reads detail.comments) carries the file:line anchors.
        comments: inline.map((c) => ({
          id: c.id,
          user: c.user,
          body: `\`${c.file_path}:${c.line}\` — ${c.body}`,
          created_at: c.created_at,
          html_url: null,
        })),
        checks: checks,
        // Empty-checks explanation (v1 config, no config, not started) —
        // null whenever check rows exist.
        checks_note: checks.length === 0 ? await ciEmptyStateNote(repoPath, statusSha) : null,
        // Backing CI run when the checks came from the push/pr-ci engine —
        // drives the client's Re-run buttons. Null for Finalize-run checks.
        ci_run: ciRunForSha(stmts, project.id, statusSha),
        // Latest run for the head (any trigger) with its job rows, so the
        // PR page renders the expandable Run → Job → Step detail even for
        // Finalize-validated PRs (where ci_run is null).
        checks_run: displayRunForSha(stmts, project.id, statusSha),
        headSha,
        commits,
        inline_comments: inline,
        // PR-scoped preview affordances. `preview_available` gates whether the
        // PR page shows the "Enable preview" control at all (a dev server must
        // be configured for the project); `preview_default_on` is the project
        // toggle that opts every PR into showing preview state by default.
        preview_available: previewAvailable,
        preview_default_on: project.prEnv?.devServer?.previewOnPullRequests === true,
        // Whether a live session worktree still backs the head branch. The
        // preview control only works while that session is alive; once it is
        // archived the worktree is reaped and `preview/start` 409s, so the
        // client shows an explanatory note instead of an Enable button. Only
        // meaningful when a dev server is configured; defaults to
        // `preview_available` when the resolver is not wired (tests).
        preview_session_available: previewAvailable
          ? deps.hasLivePreviewSession
            ? deps.hasLivePreviewSession(project, row.head_branch)
            : true
          : false,
      };
    },

    async diff({ project, number }) {
      const repoPath = requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      const { baseSha, headSha } = await resolvePrShas(repoPath, row);
      return { source: 'agenthub' as const, diff: await prDiff(repoPath, baseSha, headSha) };
    },

    async files({ project, number }) {
      const repoPath = requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      const { baseSha, headSha } = await resolvePrShas(repoPath, row);
      return { source: 'agenthub' as const, files: await prFiles(repoPath, baseSha, headSha) };
    },

    async merge({ project, number, mergeMethod, actor }) {
      const repoPath = requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        return { ok: false as const, status: 409, error: `PR #${number} is ${row.status}` };
      }

      const blocked = await mergeBlockedReason(stmts, project, row, repoPath);
      if (blocked) {
        return { ok: false as const, status: 409, error: blocked };
      }

      const result = await mergePullRequest({
        repoPath,
        baseBranch: row.base_branch,
        headBranch: row.head_branch,
        prNumber: row.number,
        prTitle: row.title,
        prBody: row.body,
        method: mergeMethod,
        actor,
        // The PR row's head_sha can lag the branch (sessions keep
        // committing); merging the live branch tip is the GitHub-like
        // behavior, so no expectedHeadSha pin here.
        // GitHub's "automatically delete head branches" — on unless the
        // project opted out in Git hosting settings.
        deleteHeadBranch: project.deleteBranchOnMerge !== false,
      });

      if (!result.ok) {
        if (result.reason === 'conflict') {
          return {
            ok: false as const,
            status: 409,
            error: `merge conflict: ${result.detail}`,
            mergeable: false as const,
          };
        }
        if (result.reason === 'missing_ref') {
          return { ok: false as const, status: 404, error: result.detail };
        }
        return { ok: false as const, status: 503, error: result.detail };
      }

      const updated = markMerged(stmts, row, {
        mergedSha: result.mergedSha,
        mergedBy: actor,
        mergeMethod,
      });
      if (!updated) {
        // DB row raced to a terminal state after the git merge landed —
        // the git side is done, so report success but log loudly.
        console.warn(
          `[native-pr] merge landed in git but row ${row.id} was no longer open (project ${project.id} #${number})`,
        );
      }

      handleCardOnMerge({ stmts, broadcast }, project.id, updated ?? row, actor);

      fireBaseBranchMoved(project, number, row.base_branch, result.mergedSha, 'merge');

      if (deps.afterPrMerged) {
        try {
          deps.afterPrMerged({ project, row: updated ?? row });
        } catch (err: unknown) {
          console.warn(
            `[native-pr] afterPrMerged hook failed for ${project.id}#${number}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      return { ok: true as const, mergedSha: result.mergedSha };
    },

    async revert({ project, number, actor }) {
      const repoPath = requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'merged' || !row.merged_sha) {
        return {
          ok: false as const,
          status: 409,
          error: `PR #${number} is ${row.status} — only a merged PR can be reverted`,
        };
      }
      if (row.revert_sha) {
        return {
          ok: false as const,
          status: 409,
          error: `PR #${number} was already reverted by ${row.revert_sha.slice(0, 12)}`,
        };
      }

      const result = await revertPullRequest({
        repoPath,
        baseBranch: row.base_branch,
        mergedSha: row.merged_sha,
        prNumber: row.number,
        actor,
      });

      if (!result.ok) {
        if (result.reason === 'missing_ref') {
          return { ok: false as const, status: 404, error: result.detail };
        }
        if (result.reason === 'conflict' || result.reason === 'not_on_base') {
          return { ok: false as const, status: 409, error: result.detail };
        }
        if (result.reason === 'empty') {
          return { ok: false as const, status: 409, error: result.detail };
        }
        return { ok: false as const, status: 503, error: result.detail };
      }

      const updated = markReverted(stmts, row, {
        revertSha: result.revertSha,
        revertedBy: actor,
      });
      if (!updated) {
        // The revert commit is already on the branch; a lost row update
        // only costs the badge, so report success and log loudly.
        console.warn(
          `[native-pr] revert landed in git but row ${row.id} could not be marked (project ${project.id} #${number})`,
        );
      }

      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'reverted',
      });

      fireBaseBranchMoved(project, number, row.base_branch, result.revertSha, 'revert');

      return { ok: true as const, revertSha: result.revertSha };
    },

    close({ project, number }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        throw new NativePrError(`PR #${number} is already ${row.status}`, 409);
      }
      const updated = markClosed(stmts, row);
      if (!updated) throw new NativePrError(`PR #${number} is no longer open`, 409);
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'closed',
      });
      return { row: updated };
    },

    reopen({ project, number }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status === 'merged') {
        throw new NativePrError(`PR #${number} is merged — it cannot be reopened`, 409);
      }
      if (row.status !== 'closed') {
        throw new NativePrError(`PR #${number} is already open`, 409);
      }
      const result = stmts.markPullRequestReopened.run(Date.now(), row.id);
      if (result.changes === 0) {
        throw new NativePrError(`PR #${number} could not be reopened`, 409);
      }
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'reopened',
      });
      return { row: requirePr(stmts, project, number) };
    },

    setReviewRequested({ project, number, requested, actor }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        throw new NativePrError(`PR #${number} is ${row.status}`, 409);
      }
      stmts.setPullRequestReviewRequested.run(
        requested ? Date.now() : null,
        requested ? actor : null,
        Date.now(),
        row.id,
      );
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: requested ? 'review_requested' : 'review_request_cleared',
      });
      return { row: requirePr(stmts, project, number) };
    },

    setAutoMerge({ project, number, enabled }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        throw new NativePrError(`PR #${number} is ${row.status} — auto-merge cannot be armed`, 409);
      }
      stmts.setPullRequestAutoMerge.run(enabled ? 1 : 0, Date.now(), row.id);
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: enabled ? 'auto_merge_enabled' : 'auto_merge_disabled',
      });
      return { row: requirePr(stmts, project, number) };
    },

    submitReview({ project, number, state, body, reviewer, sessionId }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        throw new NativePrError(`PR #${number} is ${row.status} — reviews are closed`, 409);
      }
      const id = randomReviewId();
      const now = Date.now();
      stmts.insertPullRequestReview.run(id, project.id, number, reviewer, state, body, now);
      // A verdict answers the outstanding review request; comments leave it.
      if (state !== 'commented' && row.review_requested_at) {
        stmts.setPullRequestReviewRequested.run(null, null, now, row.id);
      }
      // Resolve the in-flight AGENT review only when THIS verdict comes from the
      // session that actually owns the claim (agent_review_session_id). Ownership
      // is by session identity, not reviewer name: a human spoofing the reviewer
      // name cannot clear a live claim, and a late verdict from a stale reviewer
      // session (after TTL reclamation handed the slot to a newer session) clears
      // 0 rows — the session-scoped release leaves the newer claim intact. The
      // reviewer turn's terminal handler is the backstop if no verdict arrives.
      if (
        state !== 'commented' &&
        row.agent_review_requested_at &&
        typeof sessionId === 'string' &&
        sessionId
      ) {
        stmts.releasePullRequestAgentReviewBySession.run(now, project.id, number, sessionId);
      }
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'reviewed',
        reviewState: state,
      });
      return {
        review: {
          id,
          user: reviewer,
          state: state.toUpperCase(),
          body,
          submitted_at: toIso(now),
          html_url: null,
        },
      };
    },

    dismissReview({ project, number, reviewId, reason, actor }) {
      requireHostedRepo(project);
      requirePr(stmts, project, number);
      const review = stmts.getPullRequestReview.get(reviewId) as
        | {
            id: string;
            project_id: string;
            pr_number: number;
            reviewer: string;
            state: string;
            dismissed_at: number | null;
          }
        | undefined;
      if (!review || review.project_id !== project.id || review.pr_number !== number) {
        throw new NativePrError('Review not found', 404);
      }
      if (review.state === 'commented') {
        throw new NativePrError('Only approve / request-changes reviews can be dismissed', 400);
      }
      const now = Date.now();
      // The UPDATE is guarded by `dismissed_at IS NULL`, so the "already
      // dismissed" decision is the write itself, not the earlier read: if a
      // concurrent request won the race between the read above and here, this
      // one changes zero rows and must 409 rather than broadcast/return a
      // dismissal that was never persisted.
      const { changes } = stmts.dismissPullRequestReview.run(actor, reason, now, reviewId);
      if (changes === 0) {
        throw new NativePrError('Review is already dismissed', 409);
      }
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'review_dismissed',
      });
      return {
        review: {
          id: review.id,
          user: review.reviewer,
          state: review.state.toUpperCase(),
          dismissed: true,
          dismissed_by: actor,
          dismissal_reason: reason,
          dismissed_at: toIso(now),
        },
      };
    },

    addInlineComment({ project, number, filePath, line, side, body, author }) {
      requireHostedRepo(project);
      const row = requirePr(stmts, project, number);
      if (row.status !== 'open') {
        throw new NativePrError(`PR #${number} is ${row.status} — comments are closed`, 409);
      }
      const id = randomReviewId();
      const now = Date.now();
      stmts.insertPullRequestComment.run(
        id,
        project.id,
        number,
        author,
        filePath,
        line,
        side,
        body,
        now,
      );
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'commented',
      });
      return {
        comment: {
          id,
          user: author,
          file_path: filePath,
          line,
          side,
          body,
          created_at: toIso(now),
        },
      };
    },

    deleteInlineComment({ project, number, commentId }) {
      requireHostedRepo(project);
      requirePr(stmts, project, number);
      const existing = stmts.getPullRequestComment.get(commentId) as
        | { project_id: string; pr_number: number; file_path: string; line: number; side: string }
        | undefined;
      if (!existing || existing.project_id !== project.id || existing.pr_number !== number) {
        throw new NativePrError('Comment not found', 404);
      }
      stmts.deletePullRequestComment.run(commentId);
      // Drop the thread's resolution once its last comment is gone, so a
      // future comment on the same line does not inherit a stale "resolved".
      const { n } = stmts.countPullRequestCommentsAtAnchor.get(
        project.id,
        number,
        existing.file_path,
        existing.line,
        existing.side,
      ) as { n: number };
      if (n === 0) {
        stmts.unresolvePullRequestCommentThread.run(
          project.id,
          number,
          existing.file_path,
          existing.line,
          existing.side,
        );
      }
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'comment_deleted',
      });
    },

    setCommentThreadResolved({ project, number, filePath, line, side, resolved, actor }) {
      requireHostedRepo(project);
      requirePr(stmts, project, number);
      const { n } = stmts.countPullRequestCommentsAtAnchor.get(
        project.id,
        number,
        filePath,
        line,
        side,
      ) as { n: number };
      if (n === 0) {
        throw new NativePrError('No comment thread at that anchor', 404);
      }
      const now = Date.now();
      if (resolved) {
        stmts.resolvePullRequestCommentThread.run(
          project.id,
          number,
          filePath,
          line,
          side,
          actor,
          now,
        );
      } else {
        stmts.unresolvePullRequestCommentThread.run(project.id, number, filePath, line, side);
      }
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: resolved ? 'comment_thread_resolved' : 'comment_thread_unresolved',
      });
      return {
        thread: {
          file_path: filePath,
          line,
          side,
          resolved,
          resolved_by: resolved ? actor : null,
          resolved_at: resolved ? toIso(now) : null,
        },
      };
    },
  };

  return service;
}

function randomReviewId(): string {
  // uuid already imported transitively elsewhere; keep this module's
  // dependency surface unchanged with crypto.randomUUID (Node 19+).
  return globalThis.crypto.randomUUID();
}

/**
 * Shas for diff/files: open PRs read live branch tips; merged/closed PRs
 * fall back to the recorded head_sha against the base's merge-base so
 * history stays viewable after branch deletion (best-effort — the head
 * commit object survives branch deletion until gc).
 */
async function resolvePrShas(
  repoPath: string,
  row: PullRequestRow,
): Promise<{ baseSha: string; headSha: string }> {
  const liveHead = await revParse(repoPath, `refs/heads/${row.head_branch}`);
  const headSha = liveHead ?? (await revParse(repoPath, row.head_sha));
  if (!headSha) {
    throw new NativePrError(`PR head commit unavailable (branch deleted and gc'd)`, 404);
  }
  const baseSha = await revParse(repoPath, `refs/heads/${row.base_branch}`);
  if (!baseSha) throw new NativePrError(`base branch ${row.base_branch} not found`, 404);
  return { baseSha, headSha };
}
