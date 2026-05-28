/**
 * POST /api/projects/:projectId/pulls/:number/nudge-reviewer
 *
 * Queues the same debounced reviewer dispatch used by GitHub webhooks
 * (`dispatchReviewerForPR`). Refuses when a reviewer session is already
 * running for this PR or a dispatch is already debounced for it.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { parseRepoFullName, resolveUserToken } from './pr-list.js';
import { dispatchReviewerForPR, isReviewerDispatchPending } from './webhooks.js';
import { findInFlightReviewerSessionId } from '../reviewer-session-inflight.js';

export default function createPrNudgeReviewerRoutes(deps: RouteDeps): Router {
  const router = Router();
  const { findProject, config, stmts, activeProcesses } = deps;

  router.post(
    '/api/projects/:projectId/pulls/:number/nudge-reviewer',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({
          error: 'Project has no githubRepo configured',
          hint: 'Set project.githubRepo to "owner/repo" to enable PR actions.',
        });
      }

      const reviewer = project.agents?.find((a) => a.role === 'reviewer');
      if (!reviewer) {
        return res.status(400).json({
          error: 'No reviewer agent configured for this project',
        });
      }

      const num = Number.parseInt(String(req.params.number), 10);
      if (!Number.isFinite(num) || num <= 0) {
        return res.status(400).json({ error: 'Invalid PR number' });
      }

      const listSessions = (agentId: string) =>
        (stmts.getSessions.all(agentId) || []) as SessionRow[];

      const busySessionId = findInFlightReviewerSessionId(
        project,
        num,
        listSessions,
        activeProcesses,
      );
      if (busySessionId) {
        return res.status(409).json({
          error: 'A reviewer session is still running for this PR.',
          activeSessionId: busySessionId,
        });
      }

      // P1 (card 2c4a0d06): consult both the in-memory debounce map AND the
      // persistent webhook_events queue. Pre-P1 this only checked the in-memory
      // map; a server restart mid-debounce would clear the map and let a
      // double-dispatch slip through. Now the queue's `pr_key` + `deferred_until`
      // columns are durable across restarts.
      if (
        isReviewerDispatchPending(project.id, num, {
          stmts,
          repoFullName: `${repo.owner}/${repo.repo}`,
        })
      ) {
        return res.status(409).json({
          error:
            'A formal review dispatch is already queued for this PR (debounce window — try again shortly).',
        });
      }

      let detail;
      try {
        const userToken = await resolveUserToken(req, config);
        detail = await fetchPrDetail(config, repo, num, { userAccessToken: userToken });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found|404/i.test(msg)) {
          return res.status(404).json({ error: `PR #${num} not found` });
        }
        return res.status(502).json({ error: `Failed to fetch PR: ${msg.split('\n')[0]}` });
      }

      const pr = detail.pr as Record<string, unknown>;
      const prUrl =
        typeof pr.html_url === 'string'
          ? pr.html_url
          : `https://github.com/${repo.owner}/${repo.repo}/pull/${num}`;
      const prTitle = typeof pr.title === 'string' ? pr.title : `PR #${num}`;
      // detail.headSha is the raw `pull_request.head.sha` from GitHub.
      // `pr.head` post-`normalizePrSummary` is the branch-ref string, NOT
      // `{sha}` — earlier code casting `pr.head as { sha?: string }` always
      // produced undefined and silently skipped the reviewer Check Run
      // (which is commit-scoped, see ensureCheckRunForPR's early return).
      const headSha = detail.headSha ?? undefined;

      const scheduled = dispatchReviewerForPR(deps, project, {
        prUrl,
        prNumber: num,
        prTitle,
        repoFullName: `${repo.owner}/${repo.repo}`,
        reason: 'manual-nudge',
        headSha,
      });

      if (!scheduled) {
        return res.status(400).json({ error: 'Could not schedule reviewer (no reviewer agent).' });
      }

      return res.status(202).json({ ok: true, scheduled: true });
    },
  );

  return router;
}
