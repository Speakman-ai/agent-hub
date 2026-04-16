/**
 * routes/pr-actions.ts — API endpoints for human PR actions (merge/close/review).
 *
 * POST /api/pr/merge   — Merge a PR by URL
 * POST /api/pr/close   — Close a PR by URL
 * POST /api/pr/review  — Submit a formal GitHub review using the GitHub App identity
 * GET  /api/pr/status  — Get PR status (mergeable, CI, reviews)
 */

import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { RouteDeps, AppConfig, GitHubAppConfig, PrStateRow } from '../types.js';
import { githubApiRequest, resolveInstallationId } from '../github-app.js';
import {
  DEFAULT_REVIEWER_PHASES,
  completeCheckRun,
  finalizePhases,
  parseSqliteTimestampMs,
  renderProgressSummary,
  reviewEventToConclusion,
} from '../check-runs.js';
import { cancelAnalyzePhaseTimer } from './webhooks.js';

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

const ALLOWED_REVIEW_EVENTS = new Set<PrReviewBody['event']>([
  'APPROVE',
  'REQUEST_CHANGES',
  'COMMENT',
]);

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
   * Mark the "Agent Hub Reviewer" Check Run as completed after a successful
   * GitHub review post. Conclusion mapping:
   *   APPROVE          → success
   *   COMMENT          → neutral   (issues found but non-blocking)
   *   REQUEST_CHANGES  → action_required
   *
   * Best-effort: any failure is logged but does not fail the `/api/pr/review`
   * response — the formal GitHub review has already landed by the time we
   * reach here.
   */
  async function completeReviewerCheckRun(
    pr: ParsedPR,
    event: PrReviewBody['event'],
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

      const headlineByEvent: Record<PrReviewBody['event'], string> = {
        APPROVE: '✅ Review complete — PR is mergeable as-is',
        COMMENT: '💬 Review complete — non-blocking notes',
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

    // Try GitHub App first
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
        if (/already.*merged|405/i.test(msg)) {
          return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
        }
        console.warn(`[PR Action] GitHub App merge failed, trying gh CLI: ${msg.split('\n')[0]}`);
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
      if (/already.*merged|405/i.test(msg)) {
        return res.json({ ok: true, alreadyMerged: true, pr: pr.number });
      }
      return res.status(500).json({ error: `Merge failed: ${msg.split('\n')[0]}` });
    }
  });

  // ─── Close a PR ─────────────────────────────────────────────────

  router.post('/api/pr/close', async (req: Request, res: Response) => {
    const { prUrl } = req.body as PrActionBody;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL' });
    }

    // Try GitHub App first
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
        console.warn(`[PR Action] GitHub App close failed, trying gh CLI: ${msg.split('\n')[0]}`);
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
      return res.status(500).json({ error: `Close failed: ${msg.split('\n')[0]}` });
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
    if (!event || !ALLOWED_REVIEW_EVENTS.has(event)) {
      return res
        .status(400)
        .json({ error: 'Invalid review event (must be APPROVE, REQUEST_CHANGES, or COMMENT)' });
    }
    if ((event === 'REQUEST_CHANGES' || event === 'COMMENT') && !body?.trim()) {
      return res
        .status(400)
        .json({ error: 'body is required when event is REQUEST_CHANGES or COMMENT' });
    }

    interface ReviewApiResponse {
      id?: number;
      html_url?: string;
      user?: { login?: string };
      state?: string;
    }

    const reviewPayload: Record<string, unknown> = { event };
    if (body?.trim()) reviewPayload.body = body;
    if (commitId) reviewPayload.commit_id = commitId;

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
          completeReviewerCheckRun(pr, event, body).catch(() => {
            /* best-effort */
          });
          return res.json({
            ok: true,
            method: 'github-app',
            pr: pr.number,
            event,
            reviewId: data.id,
            reviewUrl: data.html_url,
            reviewer: data.user?.login,
            state: data.state,
          });
        }
        console.warn(
          `[PR Review] GitHub App configured but no installation matched owner "${pr.owner}" — falling back to bot token`,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[PR Review] GitHub App review failed, trying bot token: ${msg.split('\n')[0]}`,
        );
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
        completeReviewerCheckRun(pr, event, body).catch(() => {
          /* best-effort */
        });
        return res.json({
          ok: true,
          method: 'bot-token',
          pr: pr.number,
          event,
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
        });
      }
    }

    // No viable auth — fallback chain exhausted
    return res.status(501).json({
      error: 'No GitHub App installation for this repo owner and no bot token configured',
      hint: 'Install the Agent Hub Reviewer GitHub App on the target org, or set botGithubToken in config.',
    });
  });

  // ─── Get PR status ──────────────────────────────────────────────

  router.get('/api/pr/status', async (req: Request, res: Response) => {
    const prUrl = req.query.prUrl as string;
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      return res.status(400).json({ error: 'Invalid PR URL (pass as ?prUrl=...)' });
    }

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
        console.warn(`[PR Action] GitHub App status failed: ${(err as Error).message}`);
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
      return res.status(500).json({ error: `Status check failed: ${msg.split('\n')[0]}` });
    }
  });

  return router;
}
