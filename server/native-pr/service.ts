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
import { buildNativePrUrl } from './url.js';
import {
  createOrGetOpenPullRequest,
  getPullRequest,
  listPullRequests,
  markClosed,
  markMerged,
  type PrListState,
} from './store.js';
import {
  blobExistsAtCommit,
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
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

/**
 * Why are there no checks on this PR? Read the ci.yaml at the head sha
 * and explain the empty state — "No checks reported" with no reason is
 * how "CI didn't run" support mysteries happen.
 */
async function ciEmptyStateNote(repoPath: string, sha: string): Promise<string | null> {
  let text: string;
  try {
    const { stdout } = await execFileP(
      'git',
      ['-C', repoPath, 'show', `${sha}:.agent-hub/ci.yaml`],
      { timeout: 15_000, maxBuffer: 1024 * 1024 },
    );
    text = stdout;
  } catch {
    return 'No CI is configured on this branch (.agent-hub/ci.yaml not found).';
  }
  const parsed = parseCiConfig(text);
  if (parsed.ok && parsed.config.version !== 2) {
    return (
      `CI checks do not run for pull requests on this project — .agent-hub/ci.yaml is ` +
      `version ${parsed.config.version} (Finalize-only). Migrate it to version 2 (jobs + runs-on) ` +
      `to enable PR checks.`
    );
  }
  if (!parsed.ok) {
    return `.agent-hub/ci.yaml failed to parse: ${parsed.error.message}`;
  }
  return 'Checks have not started yet for the head commit.';
}
import { mergePullRequest, type MergeMethod } from './merge.js';
import { handleCardOnMerge } from './card-on-merge.js';

export { NativePrError } from './errors.js';
import { NativePrError } from './errors.js';

export interface NativePrServiceDeps {
  stmts: Stmts;
  broadcast: BroadcastFn;
  /**
   * Post-merge hook — the hosting layer's GitHub mirror push. Fired and
   * forgotten; a mirror failure never rolls back the merge.
   */
  afterMerge?: (args: { project: Project; baseBranch: string; mergedSha: string }) => Promise<void>;
  /**
   * Fired when a PR is created or an open PR is reused with a fresh head
   * sha — the PR-level CI trigger (which skips Finalize-validated heads).
   * Fire-and-forget.
   */
  onPrHeadChanged?: (project: Project, row: PullRequestRow) => void;
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
  }): Array<Record<string, unknown>>;
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
    headSha: string | null;
    commits: PrCommitEntry[];
    /** Raw inline diff comments for in-diff rendering. */
    inline_comments: Array<Record<string, unknown>>;
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
  /** Record a human review; approve/changes-requested clears the request flag. */
  submitReview(args: {
    project: Project;
    number: number;
    state: 'approved' | 'changes_requested' | 'commented';
    body: string;
    reviewer: string;
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
  const validated = Boolean(
    stmts.getValidatedFinalizeRunForSha.get(project.id, row.head_branch, headSha),
  );

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
    const hasCiConfig = await blobExistsAtCommit(repoPath, headSha, '.agent-hub/ci.yaml');
    if (hasCiConfig) {
      const run = stmts.getLatestFinalizeRunForSha.get(project.id, headSha, headSha) as
        | { status: string }
        | undefined;
      if (!run) {
        return 'Branch protection: checks have not run for the head commit yet.';
      }
      if (run.status === 'queued' || run.status === 'running') {
        return 'Branch protection: checks are still running for the head commit.';
      }
      const passing =
        run.status === 'succeeded' || run.status === 'ready_to_push' || run.status === 'pushed';
      if (!passing) {
        return 'Branch protection: checks failed for the head commit — fix and re-run before merging.';
      }
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

/** Inline diff comments, raw (for in-diff rendering) and folded. */
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
  return rows.map((r) => ({
    id: r.id,
    user: r.author,
    file_path: r.file_path,
    line: r.line,
    side: r.side,
    body: r.body,
    created_at: toIso(r.created_at),
  }));
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
  }>;
  return rows.map((r) => ({
    id: r.id,
    user: r.reviewer,
    state: r.state.toUpperCase(), // APPROVED / CHANGES_REQUESTED / COMMENTED
    body: r.body,
    submitted_at: toIso(r.created_at),
    html_url: null,
  }));
}

/**
 * GitHub-GraphQL-style review decision for list rows: latest review per
 * reviewer wins (comments never supersede a verdict), changes-requested
 * beats approved, and a pending review-request flag reads as
 * REVIEW_REQUIRED.
 */
function reviewDecisionFor(stmts: Stmts, projectId: string, row: PullRequestRow): string | null {
  const reviews = stmts.listPullRequestReviewsForPr.all(projectId, row.number) as Array<{
    reviewer: string;
    state: string;
  }>;
  const latestByUser = new Map<string, string>();
  for (const r of reviews) {
    const prev = latestByUser.get(r.reviewer);
    if (r.state === 'commented' && prev && prev !== 'commented') continue;
    latestByUser.set(r.reviewer, r.state);
  }
  const states = [...latestByUser.values()];
  if (states.includes('changes_requested')) return 'CHANGES_REQUESTED';
  if (states.includes('approved')) return 'APPROVED';
  if (row.review_requested_at) return 'REVIEW_REQUIRED';
  return null;
}

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

  return {
    createOrGetOpenPr({ project, headBranch, baseBranch, headSha, title, body, author }) {
      requireHostedRepo(project);
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
        deps.onPrHeadChanged?.(project, row);
      } catch {
        /* CI trigger must never fail PR creation */
      }
      return { row, prUrl, created };
    },

    listPulls({ project, state, limit }) {
      if (!isAgentHubHosted(project)) {
        throw new NativePrError('Project is not Agent Hub-hosted', 400);
      }
      return listPullRequests(stmts, project.id, state, limit).map((row) =>
        summarize(project.id, row, {
          review_decision: reviewDecisionFor(stmts, project.id, row),
          // CI status badge on list rows. Uses the recorded head_sha (no
          // per-row git call); the detail view resolves the live head.
          check_rollup: checksForSha(stmts, project.id, row.head_sha),
          linked_card: linkedCardFor(stmts, project.id, row.number),
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
        stmts.getValidatedFinalizeRunForSha.get(project.id, row.head_branch, statusSha),
      );
      // Surface the protection verdict so the Merge button disables with
      // the same reason the merge endpoint would 409 with.
      const blockedReason =
        row.status === 'open' ? await mergeBlockedReason(stmts, project, row, repoPath) : null;
      const checks = checksForSha(stmts, project.id, statusSha);
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
        headSha,
        commits,
        inline_comments: inline,
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

      if (deps.afterMerge) {
        void deps
          .afterMerge({ project, baseBranch: row.base_branch, mergedSha: result.mergedSha })
          .catch((err: unknown) => {
            console.warn(
              `[native-pr] afterMerge hook failed for ${project.id}#${number}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          });
      }

      return { ok: true as const, mergedSha: result.mergedSha };
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

    submitReview({ project, number, state, body, reviewer }) {
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
        | { project_id: string; pr_number: number }
        | undefined;
      if (!existing || existing.project_id !== project.id || existing.pr_number !== number) {
        throw new NativePrError('Comment not found', 404);
      }
      stmts.deletePullRequestComment.run(commentId);
      broadcast({
        type: 'native_pr_update',
        projectId: project.id,
        prNumber: number,
        action: 'comment_deleted',
      });
    },
  };
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
