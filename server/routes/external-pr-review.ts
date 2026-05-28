/**
 * routes/external-pr-review.ts — Manual external-PR review trigger.
 *
 * POST /api/projects/:projectId/external-pr-review
 *
 * Body: `{ prUrl: string }`
 *
 * Spawns a reviewer-only session for an **external** GitHub PR — one not
 * pushed by the Finalize orchestrator (contributor, dependabot, direct
 * `git push`). Wired through §11 of `finalize-code-changes-architecture-v0`:
 *
 *   - Internal PRs (provenance=internal) are rejected with 409 — they were
 *     already reviewed pre-PR by Finalize, the registry knows about them,
 *     and re-reviewing is redundant. Operators who explicitly need a second
 *     pass on an internal PR can use the per-row "Nudge reviewer" button on
 *     the PR list, which has no provenance check.
 *   - External PRs hit the same `dispatchReviewerForPR` machinery as the
 *     existing nudge route, just with `reason: 'external-manual'`. The
 *     reviewer session posts a single formal review back to GitHub via the
 *     Reviewer App auth (`POST /api/pr/review`) and exits — no fix loop.
 *
 * The PR URL must belong to the project's configured `githubRepo`. We don't
 * support arbitrary cross-repo review at v0: the Reviewer App's installation
 * token is repo-scoped, and the spawned reviewer agent fetches the diff via
 * Agent Hub's own read proxy which keys off the project.
 */
import { Router, Request, Response } from 'express';
import type { RouteDeps, SessionRow } from '../types.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { parseRepoFullName, resolveUserToken } from './pr-list.js';
import { dispatchReviewerForPR, isReviewerDispatchPending } from './webhooks.js';
import { findInFlightReviewerSessionId } from '../reviewer-session-inflight.js';
import { classifyPr } from '../finalize/provenance.js';

export interface ParsedGitHubPrUrl {
  owner: string;
  repo: string;
  number: number;
  /** Canonical `https://github.com/owner/repo/pull/N` form (strips fragments/queries). */
  canonical: string;
}

/**
 * Parse a GitHub PR URL into `{owner, repo, number, canonical}`. Returns
 * `null` for any string that isn't a recognisable PR URL — including
 * issue URLs, raw repo URLs, and pathological inputs like
 * `https://example.com/o/r/pull/1`.
 *
 * Accepted shapes:
 *   - `https://github.com/owner/repo/pull/42`
 *   - `https://github.com/owner/repo/pull/42/files`
 *   - `https://github.com/owner/repo/pull/42#issuecomment-…`
 *   - `http://` variants
 *   - Leading/trailing whitespace is trimmed
 *
 * Returned `canonical` always uses `https://github.com/…/pull/N` with no
 * trailing path/query/fragment so callers can use it as a cache / registry
 * key without worrying about user-pasted noise.
 */
export function parseGitHubPrUrl(value: string | null | undefined): ParsedGitHubPrUrl | null {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i,
  );
  if (!match) return null;
  const owner = match[1];
  const repo = match[2];
  const number = Number.parseInt(match[3], 10);
  if (!Number.isFinite(number) || number <= 0) return null;
  return {
    owner,
    repo,
    number,
    canonical: `https://github.com/${owner}/${repo}/pull/${number}`,
  };
}

export default function createExternalPrReviewRoutes(deps: RouteDeps): Router {
  const router = Router();
  const { findProject, config, stmts, activeProcesses } = deps;

  router.post(
    '/api/projects/:projectId/external-pr-review',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const body = (req.body ?? {}) as { prUrl?: unknown };
      const prUrlRaw = typeof body.prUrl === 'string' ? body.prUrl : '';
      const parsed = parseGitHubPrUrl(prUrlRaw);
      if (!parsed) {
        return res.status(400).json({
          error: 'Invalid PR URL — expected https://github.com/owner/repo/pull/N',
        });
      }

      const projectRepo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!projectRepo) {
        return res.status(400).json({
          error: 'Project has no githubRepo configured',
          hint: 'Set project.githubRepo to "owner/repo" to enable external PR review.',
        });
      }

      // Repo must match the project's configured githubRepo. Reviewer App
      // installation tokens are repo-scoped; the spawned reviewer agent's
      // /api/pr/* read proxy uses the project's installation.
      const sameRepo =
        parsed.owner.toLowerCase() === projectRepo.owner.toLowerCase() &&
        parsed.repo.toLowerCase() === projectRepo.repo.toLowerCase();
      if (!sameRepo) {
        return res.status(400).json({
          error: `PR repo "${parsed.owner}/${parsed.repo}" does not match project repo "${projectRepo.owner}/${projectRepo.repo}"`,
          hint: 'Cross-repo review is not supported at v0. Open the PR from a project whose githubRepo matches.',
        });
      }

      const reviewer = project.agents?.find((a) => a.role === 'reviewer');
      if (!reviewer) {
        return res.status(400).json({
          error: 'No reviewer agent configured for this project',
        });
      }

      // Reject internal PRs explicitly. The "Nudge reviewer" button on the PR
      // list is the right surface for re-reviewing an internal PR (it skips
      // this provenance check by design — its purpose is to re-trigger our
      // own reviewer on a finalize-pushed PR that already lives on GitHub).
      const classification = await classifyPr({ stmts }, parsed.canonical);
      if (classification.provenance === 'internal') {
        return res.status(409).json({
          error:
            'This PR was pushed by the Finalize orchestrator (internal). Use the per-row "Nudge reviewer" button to re-trigger review on internal PRs.',
          provenance: classification.provenance,
          via: classification.via,
        });
      }

      const listSessions = (agentId: string) =>
        (stmts.getSessions.all(agentId) || []) as SessionRow[];

      const busySessionId = findInFlightReviewerSessionId(
        project,
        parsed.number,
        listSessions,
        activeProcesses,
      );
      if (busySessionId) {
        return res.status(409).json({
          error: 'A reviewer session is still running for this PR.',
          activeSessionId: busySessionId,
        });
      }

      const repoFullName = `${projectRepo.owner}/${projectRepo.repo}`;
      if (
        isReviewerDispatchPending(project.id, parsed.number, {
          stmts,
          repoFullName,
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
        detail = await fetchPrDetail(config, projectRepo, parsed.number, {
          userAccessToken: userToken,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not found|404/i.test(msg)) {
          return res.status(404).json({ error: `PR #${parsed.number} not found` });
        }
        return res.status(502).json({ error: `Failed to fetch PR: ${msg.split('\n')[0]}` });
      }

      const pr = detail.pr as Record<string, unknown>;
      const prTitle = typeof pr.title === 'string' ? pr.title : `PR #${parsed.number}`;
      // detail.headSha is the raw `pull_request.head.sha` from GitHub — exposed
      // at the top level because normalizePrSummary collapses `pr.head` into a
      // branch-ref string and drops the SHA. The GitHub Check Run created by
      // dispatchReviewerForPR is commit-scoped, so this MUST be the SHA, not
      // the branch name. Undefined → no Check Run (early-returns in
      // ensureCheckRunForPR), the review itself still proceeds.
      const headSha = detail.headSha ?? undefined;
      const prUrlNormalized = typeof pr.html_url === 'string' ? pr.html_url : parsed.canonical;

      const scheduled = dispatchReviewerForPR(deps, project, {
        prUrl: prUrlNormalized,
        prNumber: parsed.number,
        prTitle,
        repoFullName,
        reason: 'external-manual',
        headSha,
      });

      if (!scheduled) {
        return res.status(400).json({ error: 'Could not schedule reviewer (no reviewer agent).' });
      }

      return res.status(202).json({
        ok: true,
        scheduled: true,
        prNumber: parsed.number,
        repoFullName,
      });
    },
  );

  return router;
}
