/**
 * routes/pr-actions.ts — API endpoints for human PR actions (merge/close/review).
 *
 * POST /api/pr/merge   — Merge a PR by URL
 * POST /api/pr/close   — Close a PR by URL
 * POST /api/pr/review  — Submit a formal GitHub review using the GitHub App identity
 * GET  /api/pr/status  — Get PR status (mergeable, CI, reviews)
 * GET  /api/pr/data    — Get full PR detail (metadata, reviews, comments, checks)
 * GET  /api/pr/diff    — Get the unified diff for a PR (text/plain)
 * GET  /api/pr/files   — Get the changed-files list for a PR (JSON)
 *
 * The three GET endpoints below are the read-side proxy that lets
 * reviewer-role spawns inspect a PR. The reviewer spawn env is deliberately
 * stripped of `GH_TOKEN` and pointed at an empty `GH_CONFIG_DIR` by
 * `applyReviewerSpawnIsolation`, so `gh pr view` / `gh pr diff` have no auth.
 * Routing reads through here keeps the App / user-OAuth credentials
 * server-side and never injects them into the spawn env.
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import type {
  RouteDeps,
  AppConfig,
  GitHubAppConfig,
  PrStateRow,
  KanbanCardRow,
  KanbanBoardRow,
  ReviewLogRow,
} from '../types.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';
import { githubUserApiRequest } from '../github-oauth.js';
import { resolveUserToken } from './pr-list.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { fetchPrDiff, fetchPrFiles } from '../pr-read-fetch.js';
import {
  DEFAULT_REVIEWER_PHASES,
  completeCheckRun,
  finalizePhases,
  parseSqliteTimestampMs,
  renderProgressSummary,
  reviewEventToConclusion,
} from '../check-runs.js';
import { cancelAnalyzePhaseTimer } from '../reviewer-analyze-phase-timer.js';
import { validateFormalReviewBody } from '../review-body-validation.js';
import { cleanupReviewerSessionForPR } from '../reviewer-session-cleanup.js';
import { removeWorkspace } from '../worktree.js';
import { dispatchAutofixFeedback } from '../autofix-dispatch.js';
import { recordDispatchedChangesRequestedReview } from '../review-feedback-dedup.js';
import { getOrCreateBoard } from './board.js';
import { dispatchReviewFeedback } from './webhooks.js';
import type { Project } from '../types.js';

const execFileAsync = promisify(execFile);

interface PrActionBody {
  prUrl: string;
  mergeMethod?: 'squash' | 'merge' | 'rebase';
}

interface PrReviewBody {
  prUrl: string;
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  body?: string;
  commitId?: string;
}

/** Events Agent Hub will post via the GitHub App. COMMENT is rejected — it does not satisfy required approval. */
const ALLOWED_REVIEW_EVENTS = new Set<'APPROVE' | 'REQUEST_CHANGES'>([
  'APPROVE',
  'REQUEST_CHANGES',
]);

const COMMENT_REVIEW_REJECTED_MESSAGE =
  'COMMENT reviews do not count toward required approval. Use APPROVE (non-blocking notes in body) or REQUEST_CHANGES (blockers).';

interface ParsedPR {
  owner: string;
  repo: string;
  number: string;
}

function parsePrUrl(prUrl: string | null | undefined): ParsedPR | null {
  const match = prUrl?.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1], repo: match[2], number: match[3] };
}

function hasGitHubApp(config: AppConfig): boolean {
  const app = config.githubApp;
  if (!(app?.appId && app?.privateKey)) return false;
  return !!(app.installationId || (app.installations && app.installations.length > 0));
}

function botGhEnv(config: AppConfig): NodeJS.ProcessEnv | undefined {
  if (!config.botGithubToken) return undefined;
  return { ...process.env, GH_TOKEN: config.botGithubToken };
}

const ALLOWED_MERGE_METHODS = new Set(['squash', 'merge', 'rebase']);

export default function createPrActionRoutes(deps: RouteDeps): Router {
  const { config, stmts } = deps;
  const router = Router();

  /**
   * Best-effort: reclaim the reviewer agent's session row + worktree clone
   * the moment its formal review lands. Wired into both `/api/pr/review`
   * success branches alongside `completeReviewerCheckRun`. Always
   * fire-and-forget — the formal review has already posted by the time we
   * reach here, so a cleanup failure must never alter the response.
   *
   * Implementation lives in `server/reviewer-session-cleanup.ts`; this
   * wrapper just supplies the route's `deps` (projects, broadcast,
   * activeProcesses) so the helper stays decoupled from `RouteDeps`.
   */
  function reclaimReviewerSession(pr: ParsedPR): void {
    try {
      cleanupReviewerSessionForPR(pr, {
        stmts,
        broadcast: deps.broadcast,
        getProjects: deps.getProjects,
        activeProcesses: deps.activeProcesses,
        removeWorkspace,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ReviewerCleanup] Hook threw for PR #${pr.number}: ${msg.split('\n')[0]}`);
    }
  }

  /**
   * Mark the "Agent Hub Reviewer" Check Run as completed after a successful
   * GitHub review post. Conclusion mapping:
   *   APPROVE          → success
   *   REQUEST_CHANGES  → action_required
   *   (COMMENT is rejected at this endpoint — legacy check-run logs may still reference it)
   *
   * Best-effort: any failure is logged but does not fail the `/api/pr/review`
   * response — the formal GitHub review has already landed by the time we
   * reach here.
   */
  async function completeReviewerCheckRun(
    pr: ParsedPR,
    event: 'APPROVE' | 'REQUEST_CHANGES',
    body: string | undefined,
  ): Promise<void> {
    const repoFullName = `${pr.owner}/${pr.repo}`;
    // Cancel any pending `analyze` phase advance up front — even if the
    // GitHub completion call below fails, we don't want a late PATCH to
    // animate the panel after the conclusion has been set elsewhere.
    cancelAnalyzePhaseTimer(repoFullName, Number(pr.number));
    try {
      if (!stmts?.getPrStateByRepoPr) return;
      const row = stmts.getPrStateByRepoPr.get(repoFullName, Number(pr.number)) as
        | PrStateRow
        | undefined;
      if (!row?.check_run_id) return;

      const startedAtMs = parseSqliteTimestampMs(row.started_at) ?? Date.now();
      const phases = finalizePhases(DEFAULT_REVIEWER_PHASES, Date.now(), startedAtMs);
      const conclusion = reviewEventToConclusion(event);

      const headlineByEvent: Record<'APPROVE' | 'REQUEST_CHANGES', string> = {
        APPROVE: '✅ Review complete — PR is mergeable as-is',
        REQUEST_CHANGES: '⚠️ Review complete — changes requested before merge',
      };
      const summary = renderProgressSummary(phases, {
        headline: headlineByEvent[event],
        footer: body ? `\n---\n${body.substring(0, 4000)}` : undefined,
      });

      await completeCheckRun(config, pr.owner, pr.repo, row.check_run_id, conclusion, {
        title: `Reviewer: ${event}`,
        summary,
      });
      if (stmts.completePrState) {
        stmts.completePrState.run(conclusion, 'post', `${repoFullName}#${pr.number}`);
      }
      console.log(
        `[CheckRun] Completed Check Run #${row.check_run_id} for PR #${pr.number} — ${conclusion}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[CheckRun] Failed to complete Check Run for PR #${pr.number}: ${msg.split('\n')[0]}`,
      );
    }
  }

  /**
   * Map a GitHub review event to the `outcome` enum stored in review_logs.
   * APPROVE          → approved
   * REQUEST_CHANGES  → changes_requested
   */
  function reviewEventToOutcome(event: 'APPROVE' | 'REQUEST_CHANGES'): ReviewLogRow['outcome'] {
    if (event === 'APPROVE') return 'approved';
    return 'changes_requested';
  }

  /**
   * Persist a row in `review_logs` after a successful review submission.
   * Best-effort: any failure is swallowed (the formal GitHub review has
   * already landed). Requires the PR to be linked to a kanban card so we can
   * attribute it to a project; if no card is found, we skip silently.
   *
   * This write path is what feeds the "Reviews" activity panel on the kanban
   * board. It was orphaned in a prior refactor — the prepared statement
   * existed but no caller invoked it, so the panel froze in time. Restoring
   * the call here revives live review-activity display.
   */
  /**
   * When the reviewer App posts REQUEST_CHANGES via this endpoint, GitHub may
   * not deliver `pull_request_review.submitted` to our kanban handler (that
   * event is off by default). Wake the card's author session here so PRs do
   * not sit in "Changes requested" with no agent working the feedback.
   */
  function dispatchAuthorAutofixForChangesRequested(args: {
    prUrl: string;
    prNumber: string;
    reviewBody: string;
    reviewerLogin: string | null | undefined;
    reviewId?: number;
  }): void {
    if (!stmts?.getKanbanCardByPrUrl || !stmts?.getKanbanBoardById) return;
    const card = stmts.getKanbanCardByPrUrl.get(args.prUrl) as KanbanCardRow | undefined;
    if (!card) {
      console.log(
        `[PR Review] No kanban card linked to ${args.prUrl} — author autofix not dispatched (use Resolve PR)`,
      );
      return;
    }
    const board = stmts.getKanbanBoardById.get(card.board_id) as KanbanBoardRow | undefined;
    if (!board) return;
    const project = deps.getProjects().find((p) => p.id === board.project_id) as
      | Project
      | undefined;
    if (!project) return;

    const reviewer = args.reviewerLogin?.trim() || 'agent-hub-reviewer';
    const feedbackMessage = `# PR Review Feedback (via GitHub)

**Reviewer:** ${reviewer}
**PR:** #${args.prNumber}

The reviewer has requested changes on your PR. Please address the feedback and push fixes.

## Review comment:
${args.reviewBody || '(No body — check inline comments on the PR)'}

## What to do:
1. Read the full review: \`gh pr view ${args.prNumber} --comments\`
2. Check for inline comments on the PR
3. Address each issue — fix the code
4. Commit and push to the same branch`;

    void (async () => {
      try {
        const boardData = getOrCreateBoard(stmts, project.id);
        const cols = boardData?.board
          ? (stmts.getKanbanColumns.all(boardData.board.id) as Array<{ id: string; name: string }>)
          : [];
        const inProgressCol = cols.find((c) => c.name.toLowerCase() === 'in progress');
        if (inProgressCol && card.column_id !== inProgressCol.id && stmts.moveKanbanCard) {
          stmts.moveKanbanCard.run(inProgressCol.id, 0, card.id);
          deps.broadcast({ type: 'kanban_update', projectId: project.id });
        }

        const result = await dispatchAutofixFeedback(
          { stmts },
          card,
          project,
          'review-changes-requested',
          feedbackMessage,
          (c, p, content) => dispatchReviewFeedback(deps, c, p, content),
        );
        console.log(
          `[PR Review] REQUEST_CHANGES on #${args.prNumber} — author dispatch session=${result.sessionId ?? '(none)'} persisted=${result.userMessagePersisted}`,
        );
        if (
          result.userMessagePersisted &&
          args.reviewId != null &&
          Number.isFinite(args.reviewId)
        ) {
          recordDispatchedChangesRequestedReview(card.id, args.reviewId);
          try {
            stmts.setCardLastDispatchedReviewId?.run(args.reviewId, card.id);
          } catch {
            /* non-critical */
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[PR Review] Author autofix dispatch failed for #${args.prNumber}: ${msg}`);
      }
    })();
  }

  function persistReviewLog(args: {
    prUrl: string;
    event: 'APPROVE' | 'REQUEST_CHANGES';
    body: string | undefined;
    reviewerLogin: string | null | undefined;
  }): void {
    try {
      if (!stmts?.createReviewLog || !stmts?.getKanbanCardByPrUrl || !stmts?.getKanbanBoardById) {
        return;
      }
      const card = stmts.getKanbanCardByPrUrl.get(args.prUrl) as KanbanCardRow | undefined;
      if (!card) return; // PR not tracked on any board — nothing to attribute
      const board = stmts.getKanbanBoardById.get(card.board_id) as KanbanBoardRow | undefined;
      if (!board) return;

      const nowIso = new Date().toISOString();
      const reviewer = args.reviewerLogin?.trim() || 'agent-hub-reviewer';
      stmts.createReviewLog.run(
        randomUUID(),
        board.project_id,
        card.id,
        args.prUrl,
        reviewer,
        card.assignee ?? null,
        card.session_id ?? null,
        reviewEventToOutcome(args.event),
        args.body ?? null,
        nowIso,
        nowIso,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[ReviewLog] Failed to persist review log: ${msg.split('\n')[0]}`);
    }
  }

  // ─── Merge a PR ─────────────────────────────────────────────────

  router.post('/api/pr/merge', async (req: Request, res: Response) => {
    const { prUrl, mergeMethod = 'squash' } = req.body as PrActionBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }
    if (!ALLOWED_MERGE_METHODS.has(mergeMethod)) {
      return res.status(400).json({ error: 'Invalid merge method' });
    }

    // Surfaced in the final error response so operators can see exactly
    // what GitHub rejected when the App tier silently falls through.
    let appTierError: string | null = null;

    // Tier 0: the caller's user OAuth token — merge shows up as the
    // human in the "merged by" attribution, which is the behavior we
    // want by default. Only applies when the user has linked GitHub.
    try {
      const userToken = await resolveUserToken(req, config);
      if (userToken) {
        await githubUserApiRequest({
          accessToken: userToken,
          endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`,
          method: 'PUT',
          body: { merge_method: mergeMethod },
        });
        // Best-effort branch deletion using the same user token.
        try {
          const prData = await githubUserApiRequest<{ head?: { ref?: string } }>({
            accessToken: userToken,
            endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
          });
          if (prData.head?.ref) {
            await githubUserApiRequest({
              accessToken: userToken,
              endpoint: `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
              method: 'DELETE',
            });
          }
        } catch {
          /* branch deletion is best-effort */
        }
        return res.json({ ok: true, method: 'user-oauth', pr: pr.number });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      if (/already.*merged/i.test(msg)) {
        return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
      }
      console.warn(`[PR Action] User OAuth merge failed, trying GitHub App: ${msg.split('\n')[0]}`);
    }

    // Tier 1: GitHub App
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`, {
            method: 'PUT',
            body: { merge_method: mergeMethod },
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          });
          // Try to delete branch
          try {
            const prData = (await githubApiRequest(
              `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
              { appId: app.appId, privateKey: app.privateKey, installationId: instId },
            )) as { head?: { ref?: string } };
            if (prData.head?.ref) {
              await githubApiRequest(
                `/repos/${pr.owner}/${pr.repo}/git/refs/heads/${prData.head.ref}`,
                {
                  method: 'DELETE',
                  appId: app.appId,
                  privateKey: app.privateKey,
                  installationId: instId,
                },
              );
            }
          } catch {
            /* branch deletion is best-effort */
          }
          return res.json({ ok: true, method: 'github-app', pr: pr.number });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        if (/already.*merged/i.test(msg)) {
          return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
        }
        appTierError = msg.split('\n')[0];
        console.warn(`[PR Action] GitHub App merge failed, trying gh CLI: ${appTierError}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      await execFileAsync(
        'gh',
        [
          'pr',
          'merge',
          pr.number,
          '--repo',
          `${pr.owner}/${pr.repo}`,
          `--${mergeMethod}`,
          '--delete-branch',
        ],
        { timeout: 30000, ...(env && { env }) },
      );
      return res.json({ ok: true, method: 'gh-cli', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/already.*merged/i.test(msg)) {
        return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
      }
      return res.status(500).json({
        error: `Merge failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  // ─── Close a PR ─────────────────────────────────────────────────

  router.post('/api/pr/close', async (req: Request, res: Response) => {
    const { prUrl } = req.body as PrActionBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }

    // Surfaced in the final error response so operators can see exactly
    // what GitHub rejected when the App tier silently falls through.
    let appTierError: string | null = null;

    // Tier 0: user OAuth — close attributes to the human.
    try {
      const userToken = await resolveUserToken(req, config);
      if (userToken) {
        await githubUserApiRequest({
          accessToken: userToken,
          endpoint: `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`,
          method: 'PATCH',
          body: { state: 'closed' },
        });
        return res.json({ ok: true, method: 'user-oauth', pr: pr.number });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : '';
      console.warn(`[PR Action] User OAuth close failed, trying GitHub App: ${msg.split('\n')[0]}`);
    }

    // Tier 1: GitHub App
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
            method: 'PATCH',
            body: { state: 'closed' },
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          });
          return res.json({ ok: true, method: 'github-app', pr: pr.number });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : '';
        appTierError = msg.split('\n')[0];
        console.warn(`[PR Action] GitHub App close failed, trying gh CLI: ${appTierError}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      await execFileAsync('gh', ['pr', 'close', pr.number, '--repo', `${pr.owner}/${pr.repo}`], {
        timeout: 30000,
        ...(env && { env }),
      });
      return res.json({ ok: true, method: 'gh-cli', pr: pr.number });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: `Close failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  // ─── Submit a formal PR review (GitHub App → bot PAT → 501) ─────
  //
  // Exists because the lead/reviewer agent session runs `gh pr review` as the
  // host's `gh` identity — which is the PR author, so GitHub rejects APPROVE
  // with "pull request authors can't submit a review of their own changes".
  // This endpoint routes the review through the GitHub App installation
  // (a distinct identity), falling back to the bot PAT.

  router.post('/api/pr/review', async (req: Request, res: Response) => {
    const { prUrl, event, body, commitId } = req.body as PrReviewBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }
    if (event === 'COMMENT') {
      return res.status(400).json({ error: COMMENT_REVIEW_REJECTED_MESSAGE });
    }
    if (!event || !ALLOWED_REVIEW_EVENTS.has(event as 'APPROVE' | 'REQUEST_CHANGES')) {
      return res
        .status(400)
        .json({ error: 'Invalid review event (must be APPROVE or REQUEST_CHANGES)' });
    }
    const reviewEvent = event as 'APPROVE' | 'REQUEST_CHANGES';

    const bodyValidation = validateFormalReviewBody(reviewEvent, body);
    if (!bodyValidation.valid) {
      return res.status(400).json({ error: bodyValidation.error });
    }
    const reviewBody = bodyValidation.trimmed;

    interface ReviewApiResponse {
      id?: number;
      html_url?: string;
      user?: { login?: string };
      state?: string;
    }

    const reviewPayload: Record<string, unknown> = { event: reviewEvent, body: reviewBody };
    if (commitId) reviewPayload.commit_id = commitId;

    // Surfaced in the final 501/502 response so operators can see exactly
    // what GitHub rejected when the App tier silently falls through.
    // Without this, the only way to see the upstream error is shell access
    // to the host for `pm2 logs`, which not all operators have.
    let appTierError: string | null = null;

    // Tier 1: GitHub App (preferred — distinct identity from PR author)
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          const data = (await githubApiRequest(
            `/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
            {
              method: 'POST',
              body: reviewPayload,
              appId: app.appId,
              privateKey: app.privateKey,
              installationId: instId,
            },
          )) as ReviewApiResponse;
          // Fire-and-forget: mark the Check Run as completed with the mapped
          // conclusion so the PR's Checks strip flips to green/yellow/red.
          completeReviewerCheckRun(pr, reviewEvent, reviewBody).catch(() => {
            /* best-effort */
          });
          // Fire-and-forget: soft-delete the reviewer's session + remove
          // its worktree clone now that the review has landed. Failure
          // here must not change the response.
          reclaimReviewerSession(pr);
          persistReviewLog({
            prUrl,
            event: reviewEvent,
            body: reviewBody,
            reviewerLogin: data.user?.login,
          });
          if (reviewEvent === 'REQUEST_CHANGES') {
            dispatchAuthorAutofixForChangesRequested({
              prUrl,
              prNumber: pr.number,
              reviewBody,
              reviewerLogin: data.user?.login,
              reviewId: typeof data.id === 'number' ? data.id : undefined,
            });
          }
          return res.json({
            ok: true,
            method: 'github-app',
            pr: pr.number,
            event: reviewEvent,
            reviewId: data.id,
            reviewUrl: data.html_url,
            reviewer: data.user?.login,
            state: data.state,
          });
        }
        appTierError = `GitHub App configured but no installation matched owner "${pr.owner}"`;
        console.warn(`[PR Review] ${appTierError} — falling back to bot token`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appTierError = msg.split('\n')[0];
        console.warn(`[PR Review] GitHub App review failed, trying bot token: ${appTierError}`);
      }
    }

    // Tier 2: bot PAT via direct GitHub API call (distinct identity if configured separately)
    if (config.botGithubToken) {
      try {
        const ghRes = await fetch(
          `https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/reviews`,
          {
            method: 'POST',
            headers: {
              Authorization: `token ${config.botGithubToken}`,
              Accept: 'application/vnd.github+json',
              'Content-Type': 'application/json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'agent-hub',
            },
            body: JSON.stringify(reviewPayload),
          },
        );
        if (!ghRes.ok) {
          const text = await ghRes.text().catch(() => '');
          throw new Error(`GitHub API ${ghRes.status}: ${text.split('\n')[0]}`);
        }
        const data = (await ghRes.json()) as ReviewApiResponse;
        completeReviewerCheckRun(pr, reviewEvent, reviewBody).catch(() => {
          /* best-effort */
        });
        reclaimReviewerSession(pr);
        persistReviewLog({
          prUrl,
          event: reviewEvent,
          body: reviewBody,
          reviewerLogin: data.user?.login,
        });
        if (reviewEvent === 'REQUEST_CHANGES') {
          dispatchAuthorAutofixForChangesRequested({
            prUrl,
            prNumber: pr.number,
            reviewBody,
            reviewerLogin: data.user?.login,
            reviewId: typeof data.id === 'number' ? data.id : undefined,
          });
        }
        return res.json({
          ok: true,
          method: 'bot-token',
          pr: pr.number,
          event: reviewEvent,
          reviewId: data.id,
          reviewUrl: data.html_url,
          reviewer: data.user?.login,
          state: data.state,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(502).json({
          error: `Bot token review failed: ${msg.split('\n')[0]}`,
          hint: 'Configure a GitHub App installation for this repo owner so reviews submit as the App identity.',
          ...(appTierError && { appTierError }),
        });
      }
    }

    // No viable auth — fallback chain exhausted. When the App tier actually
    // ran and threw, the error message that historically said "No GitHub App
    // installation" was misleading: the App was configured, GitHub just
    // rejected the review (403 / 422 / 404 / etc.). Surface that distinction
    // so operators don't chase phantom installation problems. Status stays
    // 501 — the wire contract for "fallback chain exhausted" — and the
    // diagnostic detail lives in `appTierError`.
    const fallbackError = appTierError
      ? 'GitHub App review request failed and no bot token is configured to fall back to'
      : 'No GitHub App installation for this repo owner and no bot token configured';
    const fallbackHint = appTierError
      ? "See appTierError for the upstream rejection; if that's a real install issue, fix the App installation. Otherwise configure botGithubToken as a fallback."
      : 'Install the Agent Hub Reviewer GitHub App on the target org, or set botGithubToken in config.';
    return res.status(501).json({
      error: fallbackError,
      hint: fallbackHint,
      ...(appTierError && { appTierError }),
    });
  });

  // ─── Get PR status ──────────────────────────────────────────────

  router.get('/api/pr/status', async (req: Request, res: Response) => {
    const prUrl = req.query.prUrl as string;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL (pass as ?prUrl=...)' });
    }

    // Surfaced in the final error response so operators can see exactly
    // what GitHub rejected when the App tier silently falls through.
    let appTierError: string | null = null;

    // Try GitHub App
    if (hasGitHubApp(config)) {
      try {
        const app = config.githubApp as GitHubAppConfig;
        const instId = resolveInstallationId(app, pr.owner);
        if (instId) {
          const data = (await githubApiRequest(`/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}`, {
            appId: app.appId,
            privateKey: app.privateKey,
            installationId: instId,
          })) as Record<string, unknown>;
          return res.json({
            number: pr.number,
            state: data.state,
            mergeable: data.mergeable,
            mergeable_state: data.mergeable_state,
            title: data.title,
            user: (data.user as Record<string, unknown>)?.login,
            head: (data.head as Record<string, unknown>)?.ref,
            base: (data.base as Record<string, unknown>)?.ref,
            additions: data.additions,
            deletions: data.deletions,
            changed_files: data.changed_files,
          });
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        appTierError = msg.split('\n')[0];
        console.warn(`[PR Action] GitHub App status failed: ${appTierError}`);
      }
    }

    // Fallback to gh CLI
    const env = botGhEnv(config);
    try {
      const { stdout } = await execFileAsync(
        'gh',
        [
          'pr',
          'view',
          pr.number,
          '--repo',
          `${pr.owner}/${pr.repo}`,
          '--json',
          'number,state,mergeable,title,headRefName,baseRefName,additions,deletions,changedFiles,author',
        ],
        { timeout: 15000, ...(env && { env }) },
      );
      const data = JSON.parse(stdout);
      return res.json({
        number: data.number,
        state: data.state?.toLowerCase(),
        mergeable: data.mergeable === 'MERGEABLE',
        title: data.title,
        user: data.author?.login,
        head: data.headRefName,
        base: data.baseRefName,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changedFiles,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(500).json({
        error: `Status check failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  // ─── Read-side proxies for reviewer-role spawns ─────────────────
  //
  // Reviewer spawns have NO local GitHub credentials (by design — see
  // `applyReviewerSpawnIsolation`). These endpoints let them fetch PR
  // contents using server-side App / user-OAuth credentials without ever
  // exposing a token to the spawned process. Auth chain mirrors
  // `pr-detail-fetch.ts`: User OAuth → GitHub App → gh CLI.
  //
  // Accepts either `?prUrl=https://github.com/owner/repo/pull/N` or the
  // explicit triple `?owner=…&repo=…&number=N`. The PR-URL form is what
  // skill scripts forward verbatim from kanban cards; the triple form is
  // convenient when the caller already has the parts split.

  function parsePrQuery(req: Request): ParsedPR | { error: string } {
    const prUrlRaw = (req.query.prUrl ?? req.query.url) as string | undefined;
    if (prUrlRaw) {
      const parsed = parsePrUrl(prUrlRaw);
      if (!parsed) return { error: 'Invalid PR URL (must be github.com/owner/repo/pull/N)' };
      return parsed;
    }
    const owner = req.query.owner as string | undefined;
    const repo = req.query.repo as string | undefined;
    const number = (req.query.number ?? req.query.pr) as string | undefined;
    if (!owner || !repo || !number) {
      return { error: 'Pass ?prUrl=…, or ?owner=…&repo=…&number=…' };
    }
    if (!/^\d+$/.test(number)) return { error: 'number must be a positive integer' };
    return { owner, repo, number };
  }

  // GET /api/pr/data — full PR detail (metadata + reviews + comments + checks)
  router.get('/api/pr/data', async (req: Request, res: Response) => {
    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const detail = await fetchPrDetail(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      return res.json({
        source: detail.source,
        pr: detail.pr,
        reviews: detail.reviews,
        comments: detail.comments,
        checks: detail.checks,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const appTierError = (err as { appTierError?: string }).appTierError;
      return res.status(502).json({
        error: `PR data fetch failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  // GET /api/pr/diff — unified diff (text/plain)
  router.get('/api/pr/diff', async (req: Request, res: Response) => {
    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const result = await fetchPrDiff(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-PR-Source', result.source);
      return res.send(result.diff);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const appTierError = (err as { appTierError?: string }).appTierError;
      return res.status(502).json({
        error: `PR diff fetch failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  // GET /api/pr/files — changed-files list (paginated, capped)
  router.get('/api/pr/files', async (req: Request, res: Response) => {
    const parsed = parsePrQuery(req);
    if ('error' in parsed) return res.status(400).json({ error: parsed.error });

    try {
      const userAccessToken = await resolveUserToken(req, config);
      const result = await fetchPrFiles(
        config,
        { owner: parsed.owner, repo: parsed.repo },
        Number(parsed.number),
        { userAccessToken },
      );
      return res.json({
        source: result.source,
        truncated: result.truncated,
        files: result.files,
        count: result.files.length,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const appTierError = (err as { appTierError?: string }).appTierError;
      return res.status(502).json({
        error: `PR files fetch failed: ${msg.split('\n')[0]}`,
        ...(appTierError && { appTierError }),
      });
    }
  });

  return router;
}
