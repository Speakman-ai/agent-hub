/**
 * routes/pr-list.ts — Project-scoped read-only PR viewer endpoints.
 *
 * GET  /api/projects/:projectId/pulls             — list PRs for the project's GitHub repo
 * GET  /api/projects/:projectId/pulls/:number     — full detail: PR + reviews + check-runs + comments
 *
 * Auth: per-user GitHub connection only (OAuth or PAT from Settings → GitHub).
 * No GitHub App or host `gh` fallback — connect your account to list PRs.
 *
 * This is a read-only surface — no mutating actions live here. Merge/close/review
 * continue to live in pr-actions.ts so that write surfaces stay consolidated.
 */

import { Router, Request, Response } from 'express';
import type { RouteDeps, AppConfig } from '../types.js';
import { githubUserApiRequest } from '../github-oauth.js';
import { getActiveAccessToken } from '../github-connections-store.js';
import { CONNECT_GITHUB_HINT } from '../github-auth-policy.js';
import type { AuthenticatedRequest } from '../auth.js';
import { fetchPrDetail } from '../pr-detail-fetch.js';
import { enrichPullListRowsWithGraphql } from '../pr-pull-list-enrichment.js';
import { isAgentHubHosted } from '../native-pr/host.js';
import { NativePrError } from '../native-pr/errors.js';

const ALLOWED_STATES = new Set(['open', 'closed', 'all']);
const DEFAULT_LIST_LIMIT = 30;
const MAX_LIST_LIMIT = 100;

interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseRepoFullName(value: string | null | undefined): ParsedRepo | null {
  if (!value) return null;
  const match = value.trim().match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

/**
 * Map `gh pr view --json mergeable` tri-state to the boolean-or-null shape
 * that the REST API (and therefore the App tier + mobile UI) expects.
 *
 *   'MERGEABLE'   → true
 *   'CONFLICTING' → false
 *   anything else (UNKNOWN, null, missing) → null
 *
 * Preserving null for UNKNOWN is important: the mobile badge renders
 * "Mergeable"/"Conflicts" only when mergeable is a boolean, so `null`
 * correctly suppresses the badge while GitHub is still computing.
 */
export function mergeableFromCli(value: unknown): boolean | null {
  if (value === 'MERGEABLE') return true;
  if (value === 'CONFLICTING') return false;
  return null;
}

export function normalizePrSummary(raw: Record<string, unknown>): Record<string, unknown> {
  const user = raw.user as Record<string, unknown> | null | undefined;
  const head = raw.head as Record<string, unknown> | null | undefined;
  const base = raw.base as Record<string, unknown> | null | undefined;
  const labels = Array.isArray(raw.labels)
    ? (raw.labels as Array<Record<string, unknown>>).map((l) => ({
        name: l.name as string,
        color: l.color as string,
      }))
    : [];
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    draft: raw.draft ?? false,
    html_url: raw.html_url,
    user: user?.login ?? null,
    user_avatar: user?.avatar_url ?? null,
    head: head?.ref ?? null,
    base: base?.ref ?? null,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
    merged_at: raw.merged_at ?? null,
    closed_at: raw.closed_at ?? null,
    labels,
    comments: raw.comments ?? 0,
    review_comments: raw.review_comments ?? 0,
    additions: raw.additions,
    deletions: raw.deletions,
    changed_files: raw.changed_files,
    mergeable:
      typeof raw.mergeable === 'boolean'
        ? raw.mergeable
        : typeof raw.mergeable === 'string'
          ? mergeableFromCli(raw.mergeable)
          : (raw.mergeable ?? null),
    mergeable_state: raw.mergeable_state ?? null,
    merge_state_status:
      raw.merge_state_status === undefined || raw.merge_state_status === null
        ? null
        : String(raw.merge_state_status),
    review_decision:
      raw.review_decision === null || raw.review_decision === undefined
        ? null
        : String(raw.review_decision),
    check_rollup: Array.isArray(raw.check_rollup) ? raw.check_rollup : null,
  };
}

/**
 * Resolve a user access token for the caller (if any). Used by
 * pr-list and pr-detail read endpoints.
 *
 * Returns null when:
 *   - the request wasn't authenticated with a JWT (e.g. the apiKey path,
 *     where there is no owning user)
 *   - the user hasn't connected GitHub
 *   - the server has no OAuth credentials configured
 *   - the stored refresh token is dead
 */
export async function resolveUserToken(req: Request, config: AppConfig): Promise<string | null> {
  const areq = req as AuthenticatedRequest;
  if (!areq.authUserId) return null;
  const personal = config.personalOAuth;
  const creds =
    personal?.clientId && personal?.clientSecret
      ? { clientId: personal.clientId, clientSecret: personal.clientSecret }
      : null;
  return getActiveAccessToken(areq.authUserId, creds);
}

export default function createPrListRoutes(deps: RouteDeps): Router {
  const { config, findProject } = deps;
  const router = Router();

  // ─── List PRs for a project ─────────────────────────────────────

  router.get(
    '/api/projects/:projectId/pulls',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const stateParam = typeof req.query.state === 'string' ? req.query.state : 'open';
      const state = ALLOWED_STATES.has(stateParam) ? stateParam : 'open';
      let limit = Number.parseInt((req.query.limit as string) || '', 10);
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIST_LIMIT;
      if (limit > MAX_LIST_LIMIT) limit = MAX_LIST_LIMIT;

      // Agent Hub-hosted projects serve from the native PR table — no
      // GitHub token involved; project access alone (visibility gate on
      // the /api/projects/:projectId mount) is the authz.
      if (isAgentHubHosted(project) && deps.nativePr) {
        try {
          const pulls = deps.nativePr.listPulls({
            project,
            state: state as 'open' | 'closed' | 'all',
            limit,
          });
          return res.json({ repo: project.id, state, source: 'agenthub', pulls });
        } catch (err: unknown) {
          const status = err instanceof NativePrError ? err.status : 500;
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(status).json({ error: msg });
        }
      }

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({
          error: 'Project has no githubRepo configured',
          hint: 'Set project.githubRepo to "owner/repo" to enable the PR viewer.',
        });
      }

      const listPath = `/repos/${repo.owner}/${repo.repo}/pulls?state=${state}&per_page=${limit}&sort=updated&direction=desc`;

      const userToken = await resolveUserToken(req, config);
      if (!userToken) {
        return res.status(401).json({ error: CONNECT_GITHUB_HINT });
      }

      try {
        const userData = await githubUserApiRequest<Array<Record<string, unknown>>>({
          accessToken: userToken,
          endpoint: listPath,
        });
        if (!Array.isArray(userData)) {
          return res.status(502).json({ error: 'Unexpected GitHub response when listing PRs' });
        }
        const pulls = userData.map(normalizePrSummary);
        try {
          await enrichPullListRowsWithGraphql({
            owner: repo.owner,
            repo: repo.repo,
            bearerToken: userToken,
            pulls,
          });
        } catch (enrichErr: unknown) {
          const em = enrichErr instanceof Error ? enrichErr.message : String(enrichErr);
          console.warn(`[PR List] User OAuth GraphQL enrichment skipped: ${em.split('\n')[0]}`);
        }
        return res.json({
          repo: `${repo.owner}/${repo.repo}`,
          state,
          source: 'user-oauth',
          pulls,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: `Failed to list PRs: ${msg.split('\n')[0]}` });
      }
    },
  );

  // ─── PR detail: PR + reviews + check-runs + issue comments ──────

  router.get(
    '/api/projects/:projectId/pulls/:number',
    async (req: Request, res: Response): Promise<Response | void> => {
      const project = findProject(req.params.projectId as string);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const num = Number.parseInt(String(req.params.number), 10);
      if (!Number.isFinite(num) || num <= 0) {
        return res.status(400).json({ error: 'Invalid PR number' });
      }

      if (isAgentHubHosted(project) && deps.nativePr) {
        try {
          const detail = await deps.nativePr.getDetail({ project, number: num });
          return res.json({ repo: project.id, ...detail });
        } catch (err: unknown) {
          const status = err instanceof NativePrError ? err.status : 500;
          const msg = err instanceof Error ? err.message : String(err);
          return res.status(status).json({ error: msg });
        }
      }

      const repo = parseRepoFullName(project.githubRepo as string | undefined);
      if (!repo) {
        return res.status(400).json({ error: 'Project has no githubRepo configured' });
      }

      try {
        const userToken = await resolveUserToken(req, config);
        const detail = await fetchPrDetail(config, repo, num, {
          userAccessToken: userToken,
        });
        return res.json({
          repo: `${repo.owner}/${repo.repo}`,
          ...detail,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(502).json({ error: `Failed to fetch PR: ${msg.split('\n')[0]}` });
      }
    },
  );

  return router;
}

// ─── Normalizers (exported for tests) ─────────────────────────────

export function normalizeReviews(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((r) => {
    const user = r.user as Record<string, unknown> | null | undefined;
    return {
      id: r.id,
      user: user?.login ?? null,
      state: r.state,
      body: r.body ?? '',
      submitted_at: r.submitted_at ?? null,
      html_url: r.html_url ?? null,
    };
  });
}

export function normalizeIssueComments(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return (raw as Array<Record<string, unknown>>).map((c) => {
    const user = c.user as Record<string, unknown> | null | undefined;
    return {
      id: c.id,
      user: user?.login ?? null,
      body: c.body ?? '',
      created_at: c.created_at ?? null,
      html_url: c.html_url ?? null,
    };
  });
}

export function normalizeCheckRuns(raw: unknown): Array<Record<string, unknown>> {
  if (!raw || typeof raw !== 'object') return [];
  const runs = (raw as Record<string, unknown>).check_runs;
  if (!Array.isArray(runs)) return [];
  return (runs as Array<Record<string, unknown>>).map((chk) => ({
    id: chk.id,
    name: chk.name,
    status: chk.status,
    conclusion: chk.conclusion ?? null,
    html_url: chk.html_url ?? null,
    started_at: chk.started_at ?? null,
    completed_at: chk.completed_at ?? null,
  }));
}
